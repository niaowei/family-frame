/*
 * 相框原生业务媒体库（E2）。
 *
 * 目录结构（全部在应用私有存储，设备更换/恢复走导出，不依赖浏览器缓存）：
 *   filesDir/library/index.json   —— 全部 Post/Media/状态 的唯一事实来源（原子写）
 *   filesDir/library/media/{mediaId}.{ext} —— 媒体文件本体
 *
 * 设计要点：
 * - index.json 先写 .tmp，fsync 后 rename；改前留 .bak 防写坏；
 * - firstReceivedAt 只在 Post 第一次落盘时写入，重复下载不刷新年龄（E2 §3）；
 * - 清理规则：照片（PHOTO+VIDEO）总数超过 60 张，且 post 首次完整接收超过 90 天，
 *   才整 post 清理；至少保留 60 张；正在展示/播放/导出的 post 受保护；
 * - 空间不足判断由 SyncEngine 在下载前调用 usableBytes()。
 */

package com.familyframe.capability;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class FrameStore {
    private static final String TAG = "FrameStore";
    private static final int INDEX_VERSION = 1;
    private static FrameStore instance;

    // ponytail: one library per app process; both activities must share its index and lock.
    public static synchronized FrameStore get(Context ctx) {
        if (instance == null) instance = new FrameStore(ctx.getApplicationContext());
        return instance;
    }

    /** 至少保留的照片张数（照片+视频合并计数） */
    public static final int KEEP_PHOTOS = 60;
    /** 照片保留期：首次完整接收后 90 天 */
    public static final long EXPIRE_MS = 90L * 24L * 3600L * 1000L;

    private final File root;
    private final File mediaDir;
    private final File indexFile;
    private final File indexBak;
    private final Object lock = new Object();

    /** 库内一条媒体记录 */
    public static class Media {
        public final String id;
        public final String type;      // PHOTO | VIDEO | VOICE
        public final String fileName;  // 相对 root 的路径
        public final String mimeType;
        public long size;

        Media(String id, String type, String fileName, String mimeType, long size) {
            this.id = id;
            this.type = type;
            this.fileName = fileName;
            this.mimeType = mimeType;
            this.size = size;
        }

        public boolean isDisplay() {
            return "PHOTO".equals(type) || "VIDEO".equals(type);
        }

        public File file(File base) {
            return new File(base, fileName);
        }
    }

    /** 库内一条家庭动态 */
    public static class Post {
        public final String id;
        public String memberName;
        public String messageText;      // 可为 null
        public long createdAt;          // 服务端发送时间（展示排序）
        public long firstReceivedAt;    // 首次完整接收时间（清理年龄锚点）
        public boolean receiptSent;     // 完整落盘回执已发送
        public boolean seenReported;    // seen 已成功上报
        public boolean heardReported;   // heard 已成功上报
        public final List<Media> media = new ArrayList<>();

        Post(String id) {
            this.id = id;
        }

        public List<Media> displayMedia() {
            List<Media> out = new ArrayList<>();
            for (Media m : media) if (m.isDisplay()) out.add(m);
            return out;
        }

        public Media firstVoice() {
            for (Media m : media) if ("VOICE".equals(m.type)) return m;
            return null;
        }

        public boolean allMediaOnDisk(File base) {
            if (media.isEmpty()) return false;
            for (Media m : media) {
                File f = m.file(base);
                if (!f.exists() || f.length() == 0) return false;
            }
            return true;
        }
    }

    private final List<Post> posts = new ArrayList<>();

    // meta
    private String lastFeedCursor = null;
    private long lastSyncAt = 0;
    private String lastSyncNote = "";

    private FrameStore(Context ctx) {
        root = new File(ctx.getFilesDir(), "library");
        mediaDir = new File(root, "media");
        indexFile = new File(root, "index.json");
        indexBak = new File(root, "index.json.bak");
        mediaDir.mkdirs();
        load();
    }

    public File root() {
        return root;
    }

    public File mediaDir() {
        return mediaDir;
    }

    private void load() {
        synchronized (lock) {
            posts.clear();
            String text = readFile(indexFile);
            if (text == null || !parseIndex(text)) {
                String bak = readFile(indexBak);
                if (bak != null && parseIndex(bak)) {
                    Log.w(TAG, "index.json 损坏，已从 .bak 恢复");
                } else {
                    Log.w(TAG, "索引为空或损坏，从空库开始（媒体文件保留，等待重新同步）");
                    lastFeedCursor = null;
                }
            }
        }
    }

    private boolean parseIndex(String text) {
        try {
            JSONObject root = new JSONObject(text);
            JSONArray arr = root.optJSONArray("posts");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject p = arr.getJSONObject(i);
                    Post post = new Post(p.getString("id"));
                    post.memberName = p.optString("memberName", "");
                    post.messageText = p.isNull("messageText") ? null : p.optString("messageText", null);
                    post.createdAt = p.optLong("createdAt", 0);
                    post.firstReceivedAt = p.optLong("firstReceivedAt", 0);
                    post.receiptSent = p.optBoolean("receiptSent", false);
                    post.seenReported = p.optBoolean("seenReported", false);
                    post.heardReported = p.optBoolean("heardReported", false);
                    JSONArray ms = p.optJSONArray("media");
                    if (ms != null) {
                        for (int j = 0; j < ms.length(); j++) {
                            JSONObject m = ms.getJSONObject(j);
                            post.media.add(new Media(
                                    m.getString("id"),
                                    m.optString("type", "PHOTO"),
                                    m.getString("fileName"),
                                    m.optString("mimeType", "application/octet-stream"),
                                    m.optLong("size", 0)));
                        }
                    }
                    posts.add(post);
                }
            }
            JSONObject meta = root.optJSONObject("meta");
            if (meta != null) {
                lastFeedCursor = meta.optString("lastFeedCursor", null);
                if ("".equals(lastFeedCursor)) lastFeedCursor = null;
                lastSyncAt = meta.optLong("lastSyncAt", 0);
                lastSyncNote = meta.optString("lastSyncNote", "");
            }
            return true;
        } catch (Exception e) {
            Log.w(TAG, "解析索引失败: " + e);
            return false;
        }
    }

    private void persistLocked() {
        try {
            JSONObject root = new JSONObject();
            root.put("version", INDEX_VERSION);
            JSONArray arr = new JSONArray();
            for (Post p : posts) {
                JSONObject po = new JSONObject();
                po.put("id", p.id);
                po.put("memberName", p.memberName);
                po.put("messageText", p.messageText == null ? JSONObject.NULL : p.messageText);
                po.put("createdAt", p.createdAt);
                po.put("firstReceivedAt", p.firstReceivedAt);
                po.put("receiptSent", p.receiptSent);
                po.put("seenReported", p.seenReported);
                po.put("heardReported", p.heardReported);
                JSONArray ms = new JSONArray();
                for (Media m : p.media) {
                    JSONObject mo = new JSONObject();
                    mo.put("id", m.id);
                    mo.put("type", m.type);
                    mo.put("fileName", m.fileName);
                    mo.put("mimeType", m.mimeType);
                    mo.put("size", m.size);
                    ms.put(mo);
                }
                po.put("media", ms);
                arr.put(po);
            }
            root.put("posts", arr);
            JSONObject meta = new JSONObject();
            meta.put("lastFeedCursor", lastFeedCursor == null ? "" : lastFeedCursor);
            meta.put("lastSyncAt", lastSyncAt);
            meta.put("lastSyncNote", lastSyncNote);
            root.put("meta", meta);

            if (indexFile.exists()) copyFile(indexFile, indexBak);
            File tmp = new File(this.root, "index.json.tmp");
            FileOutputStream out = new FileOutputStream(tmp);
            out.write(root.toString().getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
            out.close();
            if (!tmp.renameTo(indexFile)) {
                // 个别文件系统 rename 覆盖失败时退回复制
                copyFile(tmp, indexFile);
                tmp.delete();
            }
        } catch (Exception e) {
            Log.e(TAG, "索引写入失败", e);
        }
    }

    private static String readFile(File f) {
        if (!f.exists()) return null;
        try (FileInputStream in = new FileInputStream(f)) {
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) != -1) buf.write(b, 0, n);
            return new String(buf.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        }
    }

    private static void copyFile(File from, File to) throws IOException {
        try (FileInputStream in = new FileInputStream(from); FileOutputStream out = new FileOutputStream(to)) {
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) != -1) out.write(b, 0, n);
            out.getFD().sync();
        }
    }

    /** 媒体文件名（相对 media/ 目录）：{mediaId}.{ext} */
    public static String mediaFileName(String mediaId, String mimeType) {
        return mediaId + "." + extForMime(mimeType);
    }

    public static String extForMime(String mime) {
        if (mime == null) return "bin";
        switch (mime) {
            case "image/jpeg": return "jpg";
            case "image/png": return "png";
            case "image/webp": return "webp";
            case "video/mp4": return "mp4";
            case "audio/webm": return "webm";
            case "audio/mp4": return "m4a";
            case "audio/ogg": return "ogg";
            case "audio/mpeg": return "mp3";
            case "audio/wav": return "wav";
            default: return "bin";
        }
    }

    /** 文件和索引必须同时存在；孤儿文件会重新经过 commitMedia 恢复索引。 */
    public boolean hasMediaLocal(String mediaId, String mimeType) {
        synchronized (lock) {
            File f = new File(mediaDir, mediaFileName(mediaId, mimeType));
            if (!f.exists() || f.length() == 0) return false;
            for (Post p : posts) for (Media m : p.media) {
                if (m.id.equals(mediaId)) return true;
            }
            return false;
        }
    }

    /** 临时下载文件位置（SyncEngine 写入后调用 commitMedia） */
    public File tmpMediaFile(String mediaId) {
        return new File(mediaDir, ".tmp-" + mediaId);
    }

    /** 把已下载完成的临时文件落进媒体库，并更新索引（含 feed 元数据）。 */
    public void commitMedia(String postId, String memberName, String messageText, long createdAt,
                             String mediaId, String type, String mimeType, File tmpFile, long now) {
        synchronized (lock) {
            Post post = findPostLocked(postId);
            boolean isNew = false;
            if (post == null) {
                post = new Post(postId);
                post.memberName = memberName;
                post.messageText = messageText;
                post.createdAt = createdAt;
                post.firstReceivedAt = now; // 首次落盘时间，此后不刷新
                posts.add(post);
                isNew = true;
            } else {
                // feed 元数据可能更新（成员改名等），落盘时间不刷新
                post.memberName = memberName;
                post.messageText = messageText;
                post.createdAt = createdAt;
            }
            String fileName = "media/" + mediaFileName(mediaId, mimeType);
            File finalFile = new File(root, fileName);
            try {
                if (finalFile.exists()) {
                    tmpFile.delete(); // 已有同内容文件：丢弃新副本
                } else if (!tmpFile.renameTo(finalFile)) {
                    copyFile(tmpFile, finalFile);
                    tmpFile.delete();
                }
            } catch (IOException e) {
                Log.e(TAG, "媒体落盘失败 " + mediaId, e);
                return;
            }
            long size = finalFile.length();
            Media existing = null;
            for (Media m : post.media) {
                if (m.id.equals(mediaId)) {
                    existing = m;
                    break;
                }
            }
            if (existing == null) {
                post.media.add(new Media(mediaId, type, fileName, mimeType, size));
            } else {
                existing.size = size;
            }
            persistLocked();
            if (isNew) Log.i(TAG, "新 post 落盘: " + postId + " firstReceivedAt=" + now);
        }
    }

    private Post findPostLocked(String postId) {
        for (Post p : posts) if (p.id.equals(postId)) return p;
        return null;
    }

    /** UI 用：全部 post 快照（按服务端时间倒序，最新在前） */
    public List<Post> postsSnapshot() {
        synchronized (lock) {
            List<Post> out = new ArrayList<>(posts);
            java.util.Collections.sort(out, (a, b) -> Long.compare(b.createdAt, a.createdAt));
            return out;
        }
    }

    public Post postById(String postId) {
        synchronized (lock) {
            return findPostLocked(postId);
        }
    }

    /** 回执发送成功标记 */
    public void markReceiptSent(String postId) {
        synchronized (lock) {
            Post p = findPostLocked(postId);
            if (p != null && !p.receiptSent) {
                p.receiptSent = true;
                persistLocked();
            }
        }
    }

    public void markSeen(String postId) {
        synchronized (lock) {
            Post p = findPostLocked(postId);
            if (p != null && !p.seenReported) {
                p.seenReported = true;
                persistLocked();
            }
        }
    }

    public void markHeard(String postId) {
        synchronized (lock) {
            Post p = findPostLocked(postId);
            if (p != null && !p.heardReported) {
                p.heardReported = true;
                persistLocked();
            }
        }
    }

    public List<Post> postsNeedFlush() {
        synchronized (lock) {
            List<Post> out = new ArrayList<>();
            for (Post p : posts) {
                if (!p.seenReported || !p.heardReported) {
                    out.add(new PostSnapshot(p));
                }
            }
            return out;
        }
    }

    private static class PostSnapshot extends Post {
        PostSnapshot(Post src) {
            super(src.id);
            memberName = src.memberName;
            messageText = src.messageText;
            createdAt = src.createdAt;
            firstReceivedAt = src.firstReceivedAt;
            receiptSent = src.receiptSent;
            seenReported = src.seenReported;
            heardReported = src.heardReported;
            media.addAll(src.media);
        }
    }

    /** 照片+视频总张数（清理规则的“照片数”） */
    public int photoCount() {
        synchronized (lock) {
            int n = 0;
            for (Post p : posts) {
                for (Media m : p.media) if (m.isDisplay()) n++;
            }
            return n;
        }
    }

    public int postCount() {
        synchronized (lock) {
            return posts.size();
        }
    }

    /**
     * 90 天 / 60 张清理（E2 §3）：只在照片总数 > 60 时执行；只清理“首次完整接收
     * 超过 90 天”的 post（整 post 清理）；清到总数 60 为止；protectedIds 中的
     * post（正在展示/播放/导出）绝不清。返回被清理的 postId。
     */
    public List<String> evictExpired(Set<String> protectedIds, long now) {
        List<String> evicted = new ArrayList<>();
        synchronized (lock) {
            int total = photoCount();
            if (total <= KEEP_PHOTOS) return evicted;
            // 候选：超期且不受保护，按首次接收时间从旧到新
            List<Post> candidates = new ArrayList<>();
            for (Post p : posts) {
                if (protectedIds != null && protectedIds.contains(p.id)) continue;
                if (now - p.firstReceivedAt > EXPIRE_MS) candidates.add(p);
            }
            java.util.Collections.sort(candidates, (a, b) -> Long.compare(a.firstReceivedAt, b.firstReceivedAt));
            boolean dirty = false;
            for (Post p : candidates) {
                int photos = 0;
                for (Media m : p.media) if (m.isDisplay()) photos++;
                if (photos == 0) {
                    // 无照片的post（纯留言）：超期即可清
                } else if (total - photos < KEEP_PHOTOS) {
                    continue; // 再清会低于 60 张保护线
                }
                posts.remove(p);
                total -= photos;
                evicted.add(p.id);
                dirty = true;
                for (Media m : p.media) {
                    new File(root, m.fileName).delete();
                }
                if (total <= KEEP_PHOTOS) break;
            }
            if (dirty) persistLocked();
        }
        return evicted;
    }

    public long usableBytes() {
        return root.getUsableSpace();
    }

    public String lastFeedCursor() {
        synchronized (lock) {
            return lastFeedCursor;
        }
    }

    public void setLastFeedCursor(String cursor, long syncAt, String note) {
        synchronized (lock) {
            lastFeedCursor = cursor;
            lastSyncAt = syncAt;
            lastSyncNote = note == null ? "" : note;
            persistLocked();
        }
    }

    public long lastSyncAt() {
        synchronized (lock) {
            return lastSyncAt;
        }
    }

    public String lastSyncNote() {
        synchronized (lock) {
            return lastSyncNote;
        }
    }

    /** Config 页统计信息 */
    public String statsLine() {
        synchronized (lock) {
            int photos = photoCount(), videos = 0, voices = 0;
            for (Post p : posts) {
                for (Media m : p.media) {
                    if ("VIDEO".equals(m.type)) videos++;
                    else if ("VOICE".equals(m.type)) voices++;
                }
            }
            long usable = root.getUsableSpace() / (1024 * 1024);
            int pending = 0;
            for (Post p : posts) if (!p.receiptSent) pending++;
            return "已保存 " + posts.size() + " 条（照片 " + photos + "、视频 " + videos
                    + "、录音 " + voices + "）｜待回执 " + pending + "｜剩余空间 " + usable + "MB";
        }
    }

    /** 恢复备份用：合并一个 post（已验证过的备份条目）。已存在的本地 post 完整保留。 */
    public void mergeRestoredPost(Post restored) {
        synchronized (lock) {
            if (findPostLocked(restored.id) != null) return;
            posts.add(restored);
            persistLocked();
        }
    }

    /** 备份用：导出索引 JSON（含全部 posts 与 meta，不含任何凭证） */
    public String exportIndexJson() {
        synchronized (lock) {
            JSONObject root = new JSONObject();
            try {
                root.put("version", INDEX_VERSION);
                root.put("exportedAt", System.currentTimeMillis());
                JSONArray arr = new JSONArray();
                for (Post p : posts) {
                    JSONObject po = new JSONObject();
                    po.put("id", p.id);
                    po.put("memberName", p.memberName);
                    po.put("messageText", p.messageText == null ? JSONObject.NULL : p.messageText);
                    po.put("createdAt", p.createdAt);
                    po.put("firstReceivedAt", p.firstReceivedAt);
                    po.put("receiptSent", p.receiptSent);
                    po.put("seenReported", p.seenReported);
                    po.put("heardReported", p.heardReported);
                    JSONArray ms = new JSONArray();
                    for (Media m : p.media) {
                        JSONObject mo = new JSONObject();
                        mo.put("id", m.id);
                        mo.put("type", m.type);
                        mo.put("fileName", m.fileName);
                        mo.put("mimeType", m.mimeType);
                        mo.put("size", m.size);
                        ms.put(mo);
                    }
                    po.put("media", ms);
                    arr.put(po);
                }
                root.put("posts", arr);
                return root.toString(2);
            } catch (Exception e) {
                return "{}";
            }
        }
    }
}

