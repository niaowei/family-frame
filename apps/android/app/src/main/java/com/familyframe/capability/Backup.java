/*
 * 储存卡备份/恢复（E2 §5，正式交付项）。
 *
 * 备份：所选储存卡目录下新建 FamilyFrameBackup-{时间戳}/（绝不覆盖旧备份）：
 *   index.json  库内容（post/留言/成员/日期/关联，不含任何凭证）
 *   media/*     媒体文件
 *   manifest.json 版本化清单：每文件大小+SHA-256
 *   写完逐一读回校验，通过后写 _SUCCESS 标记；任何失败写 _FAILED 并报错
 * 恢复：只认带 _SUCCESS 的备份目录；逐文件校验 SHA-256；
 *   已存在的媒体跳过（去重），本地已有 post 完整保留；
 *   恢复的 post 保留原始日期/接收时间，不当作新发送；
 *   不还原云凭证（令牌本来就不在备份里）。
 */

package com.familyframe.capability;

import android.content.Context;
import android.net.Uri;
import android.provider.DocumentsContract;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class Backup {
    public static final String DIR_PREFIX = "FamilyFrameBackup-";
    public static final String MANIFEST = "manifest.json";
    public static final String SUCCESS = "_SUCCESS";

    public static class Summary {
        public boolean ok;
        public String dirName;
        public int files;
        public long bytes;
        public String error;
        public int restoredPosts, skippedPosts, restoredMedia, skippedMedia;
    }

    // ---------------- 备份 ----------------

    public static Summary export(Context ctx, Uri treeUri, FrameStore store) {
        Summary s = new Summary();
        try {
            String dirName = DIR_PREFIX + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
            android.content.ContentResolver res = ctx.getContentResolver();
            String rootDoc = DocumentsContract.getTreeDocumentId(treeUri);
            Uri parent = DocumentsContract.buildDocumentUriUsingTree(treeUri, rootDoc);
            Uri dir = DocumentsContract.createDocument(res, parent, DocumentsContract.Document.MIME_TYPE_DIR, dirName);
            if (dir == null) {
                s.error = "无法创建备份目录";
                return s;
            }
            Uri mediaDir = DocumentsContract.createDocument(res, dir, DocumentsContract.Document.MIME_TYPE_DIR, "media");
            if (mediaDir == null) {
                s.error = "无法创建媒体子目录";
                return s;
            }

            java.util.List<FrameStore.Post> posts = store.postsSnapshot();
            JSONObject manifest = new JSONObject();
            JSONArray files = new JSONArray();
            manifest.put("version", 1);
            manifest.put("app", "family-frame-android");
            manifest.put("createdAt", System.currentTimeMillis());
            manifest.put("postCount", posts.size());

            // index.json
            String indexJson = store.exportIndexJson();
            Uri indexUri = createAndWrite(res, dir, "index.json", "application/json", indexJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            if (indexUri == null) { s.error = "写入 index.json 失败"; fail(res, dir, s); return s; }
            files.put(fileEntry("index.json", indexJson.getBytes(java.nio.charset.StandardCharsets.UTF_8).length, null));

            // 媒体
            int mediaCount = 0;
            for (FrameStore.Post p : posts) {
                for (FrameStore.Media m : p.media) {
                    File src = m.file(store.root());
                    if (!src.exists() || src.length() == 0) continue;
                    String name = m.fileName.substring(m.fileName.lastIndexOf('/') + 1);
                    String mime = m.mimeType == null ? "application/octet-stream" : m.mimeType;
                    Uri dst = createAndWrite(res, mediaDir, name, mime, readFileBytes(src));
                    if (dst == null) { s.error = "写入媒体失败：" + name; fail(res, dir, s); return s; }
                    files.put(fileEntry("media/" + name, src.length(), sha256File(src)));
                    mediaCount++;
                    s.bytes += src.length();
                }
            }
            manifest.put("mediaCount", mediaCount);
            manifest.put("files", files);

            byte[] manifestBytes = manifest.toString(2).getBytes(java.nio.charset.StandardCharsets.UTF_8);
            Uri manifestUri = createAndWrite(res, dir, MANIFEST, "application/json", manifestBytes);
            if (manifestUri == null) { s.error = "写入清单失败"; fail(res, dir, s); return s; }

            // 读回核验：每个文件重读并比对 SHA-256
            int verified = 0;
            for (int i = 0; i < files.length(); i++) {
                JSONObject fe = files.getJSONObject(i);
                String path = fe.getString("path");
                Uri dirForFile = path.startsWith("media/") ? mediaDir : dir;
                String name = path.startsWith("media/") ? path.substring("media/".length()) : path;
                Uri fileDoc = findChild(res, dirForFile, name);
                if (fileDoc == null) { s.error = "核验失败：缺少 " + path; fail(res, dir, s); return s; }
                String hash = sha256Stream(res.openInputStream(fileDoc));
                if (hash == null || !hash.equals(fe.optString("sha256"))) {
                    s.error = "核验失败：内容不一致 " + path;
                    fail(res, dir, s);
                    return s;
                }
                verified++;
            }

            // _SUCCESS（成功标记，恢复只认这个）
            JSONObject ok = new JSONObject();
            ok.put("ok", true);
            ok.put("verifiedFiles", verified);
            ok.put("totalBytes", s.bytes);
            ok.put("createdAt", System.currentTimeMillis());
            createAndWrite(res, dir, SUCCESS, "application/json", ok.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));

            s.ok = true;
            s.dirName = dirName;
            s.files = verified;
        } catch (Exception e) {
            s.error = "备份失败：" + e.getClass().getSimpleName() + " " + e.getMessage();
        }
        return s;
    }

    private static void fail(android.content.ContentResolver res, Uri dir, Summary s) {
        try {
            JSONObject f = new JSONObject();
            f.put("ok", false);
            f.put("error", s.error == null ? "unknown" : s.error);
            f.put("createdAt", System.currentTimeMillis());
            createAndWrite(res, dir, "_FAILED", "application/json", f.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (Exception ignored) {
        }
    }

    private static JSONObject fileEntry(String path, long size, String sha256) throws Exception {
        JSONObject o = new JSONObject();
        o.put("path", path);
        o.put("size", size);
        o.put("sha256", sha256);
        return o;
    }

    // ---------------- 恢复 ----------------

    public static Summary restore(Context ctx, Uri treeUri, FrameStore store) {
        Summary s = new Summary();
        try {
            android.content.ContentResolver res = ctx.getContentResolver();
            String rootDoc = DocumentsContract.getTreeDocumentId(treeUri);
            Uri dir = DocumentsContract.buildDocumentUriUsingTree(treeUri, rootDoc);

            Uri successDoc = findChild(res, dir, SUCCESS);
            if (successDoc == null) {
                s.error = "这个目录没有成功完成的备份标记（_SUCCESS），不能恢复";
                return s;
            }
            Uri manifestDoc = findChild(res, dir, MANIFEST);
            if (manifestDoc == null) {
                s.error = "找不到清单文件";
                return s;
            }
            JSONObject manifest = new JSONObject(readAll(res.openInputStream(manifestDoc)));
            if (manifest.optInt("version", -1) != 1) {
                s.error = "清单版本不认识：" + manifest.optInt("version", -1);
                return s;
            }

            // 媒体文件逐一校验并落回本地
            JSONArray files = manifest.optJSONArray("files");
            if (files == null) {
                s.error = "清单缺少文件列表";
                return s;
            }
            Uri mediaDir = findChildDir(res, dir, "media");
            if (mediaDir == null) {
                s.error = "备份缺少 media 目录";
                return s;
            }
            java.util.Map<String, Boolean> restored = new java.util.HashMap<>();
            for (int i = 0; i < files.length(); i++) {
                JSONObject fe = files.getJSONObject(i);
                String path = fe.getString("path");
                if (!path.startsWith("media/")) continue;
                String name = path.substring("media/".length());
                Uri fileDoc = findChild(res, mediaDir, name);
                if (fileDoc == null) {
                    s.error = "备份缺少文件：" + path;
                    return s;
                }
                String expect = fe.optString("sha256");
                String actual = sha256Stream(res.openInputStream(fileDoc));
                if (actual == null || !actual.equals(expect)) {
                    s.error = "文件校验失败：" + path;
                    return s;
                }
                String mediaId = name.contains(".") ? name.substring(0, name.lastIndexOf('.')) : name;
                if (restored.containsKey(mediaId)) continue;
                // 直接复制进本地媒体目录（文件名一致；去重交给下一步按 id 判断）
                File out = new File(store.mediaDir(), name);
                if (out.exists() && out.length() == fe.optLong("size", -1)) {
                    s.skippedMedia++;
                    restored.put(mediaId, true);
                    continue;
                }
                copyStream(res.openInputStream(fileDoc), out);
                s.restoredMedia++;
                restored.put(mediaId, true);
            }

            // index.json 合并（只加本地没有的 post；保留原日期；不动已存在的）
            Uri indexDoc = findChild(res, dir, "index.json");
            if (indexDoc == null) {
                s.error = "备份缺少 index.json";
                return s;
            }
            JSONObject backupIndex = new JSONObject(readAll(res.openInputStream(indexDoc)));
            JSONArray posts = backupIndex.optJSONArray("posts");
            if (posts != null) {
                for (int i = 0; i < posts.length(); i++) {
                    JSONObject po = posts.getJSONObject(i);
                    String pid = po.optString("id", null);
                    if (pid == null || store.postById(pid) != null) {
                        s.skippedPosts++;
                        continue;
                    }
                    FrameStore.Post p = new FrameStore.Post(pid);
                    p.memberName = po.optString("memberName", "");
                    p.messageText = po.isNull("messageText") ? null : po.optString("messageText", null);
                    p.createdAt = po.optLong("createdAt", 0);
                    p.firstReceivedAt = po.optLong("firstReceivedAt", 0);
                    p.receiptSent = po.optBoolean("receiptSent", false);
                    p.seenReported = po.optBoolean("seenReported", false);
                    p.heardReported = po.optBoolean("heardReported", false);
                    JSONArray ms = po.optJSONArray("media");
                    boolean hasOnDisk = false;
                    if (ms != null) {
                        for (int j = 0; j < ms.length(); j++) {
                            JSONObject mo = ms.getJSONObject(j);
                            FrameStore.Media m = new FrameStore.Media(
                                    mo.getString("id"),
                                    mo.optString("type", "PHOTO"),
                                    mo.getString("fileName"),
                                    mo.optString("mimeType", "application/octet-stream"),
                                    mo.optLong("size", 0));
                            File f = m.file(store.root());
                            if (f.exists() && f.length() > 0) {
                                m.size = f.length();
                                p.media.add(m);
                                hasOnDisk = true;
                            }
                        }
                    }
                    if (hasOnDisk) {
                        store.mergeRestoredPost(p);
                        s.restoredPosts++;
                    }
                }
            }
            s.ok = true;
        } catch (Exception e) {
            s.error = "恢复失败：" + e.getClass().getSimpleName() + " " + e.getMessage();
        }
        return s;
    }

    // ---------------- SAF 基础操作 ----------------

    private static Uri createAndWrite(android.content.ContentResolver res, Uri dir, String name, String mime, byte[] data) {
        try {
            Uri doc = DocumentsContract.createDocument(res, dir, mime, name);
            if (doc == null) return null;
            try (OutputStream out = res.openOutputStream(doc)) {
                out.write(data);
                out.flush();
            }
            return doc;
        } catch (Exception e) {
            return null;
        }
    }

    private static Uri findChild(android.content.ContentResolver res, Uri dir, String name) {
        return findChildInternal(res, dir, name, false);
    }

    private static Uri findChildDir(android.content.ContentResolver res, Uri dir, String name) {
        return findChildInternal(res, dir, name, true);
    }

    private static Uri findChildInternal(android.content.ContentResolver res, Uri dir, String name, boolean wantDir) {
        try {
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(dir, DocumentsContract.getDocumentId(dir));
            android.database.Cursor c = res.query(children,
                    new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                            DocumentsContract.Document.COLUMN_MIME_TYPE},
                    null, null, null);
            if (c == null) return null;
            try {
                while (c.moveToNext()) {
                    String docId = c.getString(0);
                    String dn = c.getString(1);
                    String mime = c.getString(2);
                    boolean isDir = DocumentsContract.Document.MIME_TYPE_DIR.equals(mime);
                    if (name.equals(dn) && isDir == wantDir) {
                        return DocumentsContract.buildDocumentUriUsingTree(dir, docId);
                    }
                }
            } finally {
                c.close();
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static byte[] readFileBytes(File f) throws Exception {
        try (FileInputStream in = new FileInputStream(f)) {
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] b = new byte[16384];
            int n;
            while ((n = in.read(b)) != -1) buf.write(b, 0, n);
            return buf.toByteArray();
        }
    }

    private static void copyStream(InputStream in, File out) throws Exception {
        try (InputStream is = in; FileOutputStream fos = new FileOutputStream(out)) {
            byte[] b = new byte[16384];
            int n;
            while ((n = is.read(b)) != -1) fos.write(b, 0, n);
            fos.getFD().sync();
        }
    }

    private static String readAll(InputStream in) throws Exception {
        try (InputStream is = in) {
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] b = new byte[16384];
            int n;
            while ((n = is.read(b)) != -1) buf.write(b, 0, n);
            return new String(buf.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    private static String sha256File(File f) throws Exception {
        try (FileInputStream in = new FileInputStream(f)) {
            return sha256Stream(in);
        }
    }

    private static String sha256Stream(InputStream in) {
        try (InputStream is = in) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] b = new byte[16384];
            int n;
            while ((n = is.read(b)) != -1) md.update(b, 0, n);
            StringBuilder sb = new StringBuilder();
            for (byte v : md.digest()) sb.append(String.format("%02x", v));
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }
}

