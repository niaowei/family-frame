/*
 * 相框同步引擎（E2）：
 * 1. 拉取 feed：优先 after 增量；整页取满继续用 before 向旧翻页（不漏第 51 条）；
 *    增量游标失效（云端已清理该 post）时自动退回全量分页；
 * 2. 下载缺失媒体：先查本地文件名（自愈孤儿），逐个经 302 预签名地址下载；
 *    下载前检查剩余空间，不足则本轮停止接收（不回执，云端保留待送达）；
 * 3. Post 全部媒体落盘后发送完整回执 complete；只有服务器确认成功才标记已送达；
 * 4. 补报 seen/heard；发送心跳；
 * 5. 成功一轮后执行 90 天/60 张清理（当前展示中的 post 受保护）。
 */

package com.familyframe.capability;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

public class SyncEngine {
    private static final String TAG = "SyncEngine";
    private static final int PAGE_SIZE = 50;
    /** 空间不足保护线：低于此值停止新增接收（家人处理；奶奶仍能看已有内容） */
    public static final long MIN_FREE_BYTES = 150L * 1024L * 1024L;
    private static final int TIMEOUT_MS = 20000;
    private static final int MAX_PAGES = 20;

    public static class Result {
        public boolean ok;
        public int newPosts;        // 有新落盘媒体的 post 数
        public int failedMedia;
        public int receiptsSent;
        public int eventsFlushed;
        public int evictedPosts;
        public boolean spaceStopped;
        public boolean tokenInvalid; // 401：需要重新配对
        public String error;

        public String summary() {
            if (ok) {
                String s = "同步成功：新增 " + newPosts + " 条，回执 " + receiptsSent + " 个";
                if (spaceStopped) s += "；空间不足已暂停接收";
                if (evictedPosts > 0) s += "；清理超期 " + evictedPosts + " 条";
                return s;
            }
            return "同步失败：" + (error == null ? "未知错误" : error);
        }
    }

    private static class FeedMedia {
        String id, type, mimeType;
    }

    private static class FeedPost {
        String id, memberName, messageText;
        long createdAt;
        List<FeedMedia> media = new ArrayList<>();
    }

    private final OkHttpClient http;
    private final FrameStore store;
    private final String base;
    private final String token;

    public SyncEngine(FrameStore store, String baseUrl, String deviceToken) {
        this.store = store;
        this.base = trimSlash(baseUrl);
        this.token = deviceToken;
        this.http = new OkHttpClient.Builder()
                .connectTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .readTimeout(TIMEOUT_MS * 3, TimeUnit.MILLISECONDS)
                .build();
    }

    private static String trimSlash(String s) {
        if (s == null) return "";
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    private Request.Builder get(String path) {
        return new Request.Builder().url(base + path).header("x-device-token", token);
    }

    /** 两个页面共用同步锁，防止同时写入同一个临时媒体文件。 */
    public Result sync(Set<String> protectedPostIds, String appVersion) {
        // ponytail: one physical frame/library; serialize sync instead of adding a job system.
        synchronized (SyncEngine.class) {
            return syncLocked(protectedPostIds, appVersion);
        }
    }

    private Result syncLocked(Set<String> protectedPostIds, String appVersion) {
        Result r = new Result();
        try {
            List<FeedPost> feed = fetchAllPending();
            if (feed == null) {
                r.error = lastError;
                if (tokenInvalid) r.tokenInvalid = true;
                return r;
            }

            long now = System.currentTimeMillis();
            // 从新到旧处理：今天的内容最先落盘可见
            for (FeedPost post : feed) {
                downloadPost(post, now, r);
            }

            // 回执：全部媒体在盘且未报过的 post
            sendReceipts(feed, r);

            // 补报 seen / heard
            flushEvents(r);

            // 心跳（best-effort）
            heartbeat(appVersion);

            // 清理：成功一轮后执行；保护当前展示
            r.evictedPosts = store.evictExpired(protectedPostIds, now).size();

            r.ok = r.failedMedia == 0 && !r.spaceStopped;
            if (!r.ok) r.error = r.spaceStopped ? "空间不足，稍后重试" : "部分媒体未下载完整，稍后重试";
            store.setLastFeedCursor(r.ok ? lastFeedCursorAfter : null, System.currentTimeMillis(), r.summary());
        } catch (Exception e) {
            Log.e(TAG, "sync 异常", e);
            r.error = e.getClass().getSimpleName() + ": " + e.getMessage();
        }
        return r;
    }

    private String lastError = null;
    private boolean tokenInvalid = false;
    private String lastFeedCursorAfter = null;

    /** 增量优先 + 向后翻页，返回从新到旧排序的全部待同步 post */
    private List<FeedPost> fetchAllPending() {
        List<FeedPost> all = new ArrayList<>();
        tokenInvalid = false;
        String cursor = store.postCount() == 0 ? null : store.lastFeedCursor();

        int attemptCursor = 0;
        while (true) {
            // 第一页：有增量游标用 after；失败（游标已被云端清理）退回全量
            String firstQuery = cursor != null ? ("?limit=" + PAGE_SIZE + "&after=" + cursor) : ("?limit=" + PAGE_SIZE);
            JSONArray posts = fetchPage(firstQuery);
            if (posts == null && cursor != null && attemptCursor == 0 && !tokenInvalid) {
                attemptCursor++;
                cursor = null; // 游标失效：全量重拉（本地媒体去重，代价可控）
                continue;
            }
            if (posts == null) return null;
            if (posts.length() == 0 && all.isEmpty()) return all; // 没有新内容

            appendFeedPosts(all, posts);

            // 整页取满：继续向旧翻页
            String before = null;
            while (posts.length() == PAGE_SIZE) {
                FeedPost oldest = all.get(all.size() - 1);
                if (oldest.id.equals(before)) break; // 防御：同一游标重复
                before = oldest.id;
                posts = fetchPage("?limit=" + PAGE_SIZE + "&before=" + before);
                if (posts == null) {
                    // 向后翻页失败：已取到的部分继续处理（下次同步重试更旧内容）
                    Log.w(TAG, "向后翻页失败，本轮先处理已取到的 " + all.size() + " 条");
                    break;
                }
                appendFeedPosts(all, posts);
            }
            return all;
        }
    }

    private void appendFeedPosts(List<FeedPost> all, JSONArray posts) {
        for (int i = 0; i < posts.length(); i++) {
            JSONObject p = posts.optJSONObject(i);
            if (p == null) continue;
            FeedPost fp = new FeedPost();
            fp.id = p.optString("id", null);
            if (fp.id == null || fp.id.isEmpty()) continue;
            fp.memberName = p.optJSONObject("member") != null
                    ? p.optJSONObject("member").optString("displayName", "") : "";
            fp.messageText = p.isNull("messageText") ? null : p.optString("messageText", null);
            fp.createdAt = parseTime(p.optString("createdAt", null));
            JSONArray ms = p.optJSONArray("media");
            if (ms != null) {
                for (int j = 0; j < ms.length(); j++) {
                    JSONObject m = ms.optJSONObject(j);
                    if (m == null) continue;
                    FeedMedia fm = new FeedMedia();
                    fm.id = m.optString("id", null);
                    fm.type = m.optString("type", "PHOTO");
                    fm.mimeType = m.optString("mimeType", "application/octet-stream");
                    if (fm.id != null && !fm.id.isEmpty()) fp.media.add(fm);
                }
            }
            // 去重（before 翻页与 after 增量可能交叠）
            boolean dup = false;
            for (FeedPost existing : all) {
                if (existing.id.equals(fp.id)) {
                    dup = true;
                    break;
                }
            }
            if (!dup) all.add(fp);
        }
        if (!all.isEmpty()) {
            String newest = all.get(0).id;
            if (lastFeedCursorAfter == null || newest.compareTo(lastFeedCursorAfter) >= 0) {
                lastFeedCursorAfter = newest;
            }
        }
    }

    private JSONArray fetchPage(String query) {
        lastError = null;
        try (Response res = http.newCall(get("/api/frame/feed" + query).build()).execute()) {
            if (res.code() == 401) {
                tokenInvalid = true;
                lastError = "设备令牌无效，请重新配对";
                return null;
            }
            if (res.code() == 429) {
                lastError = "服务器限流，稍后自动重试";
                return null;
            }
            if (res.code() == 400) {
                lastError = "请求参数错误";
                return null;
            }
            if (!res.isSuccessful() || res.body() == null) {
                lastError = "网络错误 HTTP " + res.code();
                return null;
            }
            JSONObject body = new JSONObject(res.body().string());
            return body.optJSONArray("posts");
        } catch (Exception e) {
            lastError = "网络不可用：" + e.getClass().getSimpleName();
            return null;
        }
    }

    private static long parseTime(String iso) {
        if (iso == null) return 0;
        try {
            java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US);
            sdf.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            java.util.Date d = sdf.parse(iso.length() > 19 ? iso.substring(0, 19) + "Z" : iso);
            return d == null ? 0 : d.getTime();
        } catch (Exception e) {
            return 0;
        }
    }

    private void downloadPost(FeedPost post, long now, Result r) {
        for (FeedMedia m : post.media) {
            if (store.hasMediaLocal(m.id, m.mimeType)) continue;
            if (r.spaceStopped) return; // 空间不足：本轮停止新增接收
            if (store.usableBytes() < MIN_FREE_BYTES) {
                r.spaceStopped = true;
                Log.w(TAG, "空间不足，停止新增接收（不回执，云端保留）");
                return;
            }
            File tmp = store.tmpMediaFile(m.id);
            if (downloadToFile("/api/frame/media/" + m.id, tmp)) {
                store.commitMedia(post.id, post.memberName, post.messageText, post.createdAt,
                        m.id, m.type, m.mimeType, tmp, now);
                r.newPosts++;
            } else {
                tmp.delete();
                r.failedMedia++;
            }
        }
    }

    private boolean downloadToFile(String path, File out) {
        try (Response res = http.newCall(get(path).build()).execute()) {
            if (!res.isSuccessful() || res.body() == null) {
                Log.w(TAG, "媒体下载失败 HTTP " + res.code() + " " + path);
                return false;
            }
            try (InputStream in = res.body().byteStream(); FileOutputStream fos = new FileOutputStream(out)) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) != -1) fos.write(buf, 0, n);
                fos.getFD().sync();
            }
            return out.length() > 0;
        } catch (IOException e) {
            Log.w(TAG, "媒体下载异常 " + path + ": " + e);
            return false;
        }
    }

    /** 媒体齐且未报回执的 post 逐个上报；云端已清理的（400）记为终态 */
    private void sendReceipts(List<FeedPost> feed, Result r) {
        Set<String> feedIds = new HashSet<>();
        for (FeedPost p : feed) feedIds.add(p.id);
        // 库里可能还有上次没报成功的
        List<FrameStore.Post> candidates = new ArrayList<>();
        for (FrameStore.Post p : store.postsSnapshot()) {
            if (!p.receiptSent && p.allMediaOnDisk(store.root())) candidates.add(p);
        }
        for (FrameStore.Post p : candidates) {
            if (!feedIds.contains(p.id) && feed != null && !feed.isEmpty()) {
                // 不在本轮 feed 中的也允许报（上轮遗留），继续
            }
            JSONArray mediaIds = new JSONArray();
            for (FrameStore.Media m : p.media) mediaIds.put(m.id);
            try {
                Request req = new Request.Builder()
                        .url(base + "/api/frame/posts/" + p.id + "/complete")
                        .header("x-device-token", token)
                        .post(RequestBody.create(MediaType.parse("application/json"),
                                new JSONObject().put("mediaIds", mediaIds).toString()))
                        .build();
                try (Response res = http.newCall(req).execute()) {
                    if (res.code() == 200) {
                        store.markReceiptSent(p.id);
                        r.receiptsSent++;
                    } else if (res.code() == 401) {
                        r.tokenInvalid = true;
                        return;
                    } else {
                        Log.w(TAG, "回执失败 HTTP " + res.code() + " post=" + p.id);
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "回执异常 post=" + p.id + ": " + e);
            }
        }
    }

    /** 补报 seen/heard（失败保留标记，下次同步重试） */
    private void flushEvents(Result r) {
        List<FrameStore.Post> pending = store.postsNeedFlush();
        for (FrameStore.Post p : pending) {
            if (!p.seenReported && postEvent(p.id, "seen")) {
                store.markSeen(p.id);
                r.eventsFlushed++;
            }
            if (!p.heardReported && postEvent(p.id, "heard")) {
                store.markHeard(p.id);
                r.eventsFlushed++;
            }
        }
    }

    public boolean postEvent(String postId, String kind) {
        try {
            Request req = new Request.Builder()
                    .url(base + "/api/frame/posts/" + postId + "/" + kind)
                    .header("x-device-token", token)
                    .post(RequestBody.create(MediaType.parse("application/json"), "{}"))
                    .build();
            try (Response res = http.newCall(req).execute()) {
                return res.code() == 200 || res.code() == 404; // 404：云端已清理，视为终态
            }
        } catch (Exception e) {
            return false;
        }
    }

    private void heartbeat(String appVersion) {
        try {
            JSONObject body = new JSONObject();
            body.put("appVersion", appVersion);
            body.put("clientTime", new java.util.Date().toString());
            body.put("cacheCount", store.postCount());
            Request req = new Request.Builder()
                    .url(base + "/api/frame/heartbeat")
                    .header("x-device-token", token)
                    .post(RequestBody.create(MediaType.parse("application/json"), body.toString()))
                    .build();
            try (Response res = http.newCall(req).execute()) {
                // best-effort
            }
        } catch (Exception ignored) {
        }
    }
}

