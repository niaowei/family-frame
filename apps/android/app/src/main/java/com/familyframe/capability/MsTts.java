/*
 * 微软 Edge 朗读在线语音合成客户端（edge-tts 协议，含 DRM Sec-MS-GEC 校验）。
 * 使用微软公共语音合成接口（zh-CN 神经语音），需联网。
 * 协议参考开源项目 edge-tts（rany2/edge-tts）master 版本：
 *   - Sec-MS-GEC：Windows 文件时间戳向下取整到 5 分钟，无分隔符直接拼 TrustedClientToken 后 SHA256。
 *   - 握手请求头必须携带 muid Cookie。
 */

package com.familyframe.capability;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

public class MsTts {
    private static final String TAG = "MsTts";
    private static final String TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    private static final String SEC_MS_GEC_VERSION = "1-143.0.3650.75";
    private static final String CHROMIUM_MAJOR = "143";
    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/" + CHROMIUM_MAJOR + ".0.0.0 Safari/537.36 Edg/" + CHROMIUM_MAJOR + ".0.0.0";
    private static final String WSS_URL =
            "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1" +
            "?TrustedClientToken=" + TRUSTED_CLIENT_TOKEN +
            "&ConnectionId=%s&Sec-MS-GEC=%s&Sec-MS-GEC-Version=" + SEC_MS_GEC_VERSION;
    private static final String OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
    /** 1601-01-01（Windows 纪元）到 1970-01-01（Unix 纪元）之间的秒数。 */
    private static final long WIN_EPOCH_SECONDS = 11644473600L;

    private final OkHttpClient client;
    /** 服务器时间与设备本地时间之差（毫秒），用于修正 Sec-MS-GEC 时钟偏差。 */
    private volatile long clockSkewMs = 0;

    public MsTts() {
        client = new OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .build();
    }

    /**
     * 同步合成文本为 MP3 文件。失败时若能从响应头 Date 判断出时钟偏差，会自动修正并重试一次。
     *
     * @return true 表示成功（mp3 文件已生成）；false 表示失败（网络/服务异常）。
     */
    public boolean synthesize(String text, String voice, File outMp3) {
        long skew = clockSkewMs;
        for (int attempt = 0; attempt < 2; attempt++) {
            Result r = trySynthesize(text, voice, outMp3, skew);
            if (r.success) return true;
            if (r.canAdjustSkew) {
                clockSkewMs = r.skewMs;
                skew = clockSkewMs;
                Log.w(TAG, "时钟偏差 " + skew + "ms，修正后重试");
                continue;
            }
            return false;
        }
        return false;
    }

    private static final class Result {
        final boolean success;
        final boolean canAdjustSkew;
        final long skewMs;

        Result(boolean success, boolean canAdjustSkew, long skewMs) {
            this.success = success;
            this.canAdjustSkew = canAdjustSkew;
            this.skewMs = skewMs;
        }
    }

    private Result trySynthesize(String text, String voice, File outMp3, long skewMs) {
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicReference<String> failure = new AtomicReference<>(null);
        final AtomicLong retrySkew = new AtomicLong(Long.MIN_VALUE);
        final ByteArrayOutputStream audioBuf = new ByteArrayOutputStream();

        String url = String.format(Locale.US, WSS_URL, connectId(), generateSecMsGec(skewMs));

        Request request = new Request.Builder().url(url)
                .header("Pragma", "no-cache")
                .header("Cache-Control", "no-cache")
                .header("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold")
                .header("User-Agent", USER_AGENT)
                .header("Accept-Encoding", "gzip, deflate, br, zstd")
                .header("Accept-Language", "en-US,en;q=0.9")
                .header("Cookie", "muid=" + generateMuid() + ";")
                .build();

        client.newWebSocket(request, new WebSocketListener() {
            @Override public void onOpen(WebSocket webSocket, Response response) {
                String date = timestamp();

                String config = "X-Timestamp:" + date + "\r\n" +
                        "Content-Type:application/json; charset=utf-8\r\n" +
                        "Path:speech.config\r\n\r\n" +
                        "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":" +
                        "{\"sentenceBoundaryEnabled\":\"true\",\"wordBoundaryEnabled\":\"false\"}," +
                        "\"outputFormat\":\"" + OUTPUT_FORMAT + "\"}}}}\r\n";
                webSocket.send(config);

                String requestId = connectId();
                String ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
                        "<voice name='" + voice + "'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>" +
                        escapeXml(sanitize(text)) + "</prosody></voice></speak>";
                webSocket.send("X-RequestId:" + requestId + "\r\n" +
                        "Content-Type:application/ssml+xml\r\n" +
                        "X-Timestamp:" + date + "Z\r\n" +
                        "Path:ssml\r\n\r\n" + ssml);
            }

            @Override public void onMessage(WebSocket webSocket, String text) {
                if (text.contains("Path:turn.end")) {
                    try { webSocket.close(1000, "done"); } catch (Exception ignored) {}
                    latch.countDown();
                } else if (text.contains("Path:response")) {
                    int idx = text.indexOf("\r\n\r\n");
                    String body = idx >= 0 ? text.substring(idx + 4) : text;
                    String marker = "\"error\":";
                    int ei = body.indexOf(marker);
                    if (ei >= 0 && !body.substring(ei + marker.length()).trim().startsWith("null")) {
                        failure.set("service_error");
                        latch.countDown();
                    }
                }
            }

            @Override public void onMessage(WebSocket webSocket, ByteString bytes) {
                byte[] data = bytes.toByteArray();
                if (data.length < 2) return;
                // 前 2 字节为大端序头长度（同 edge-tts：int.from_bytes(data[:2], "big")），
                // 音频数据从 2 + headerLength 开始。
                int headerLen = ((data[0] & 0xFF) << 8) | (data[1] & 0xFF);
                int payloadStart = 2 + headerLen;
                if (payloadStart < data.length) {
                    audioBuf.write(data, payloadStart, data.length - payloadStart);
                }
            }

            @Override public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                // 握手被服务器拒绝（如 403）时，用响应头 Date 计算设备时钟偏差，用于修正 Sec-MS-GEC 后重试。
                if (response != null && response.header("Date") != null) {
                    Long serverSeconds = parseHttpDate(response.header("Date"));
                    if (serverSeconds != null) {
                        long skew = serverSeconds * 1000L - System.currentTimeMillis();
                        if (Math.abs(skew) > 30000L) retrySkew.set(skew);
                    }
                }
                failure.set(t == null ? "unknown" : t.getClass().getSimpleName());
                latch.countDown();
            }

            @Override public void onClosed(WebSocket webSocket, int code, String reason) {
                latch.countDown();
            }
        });

        try {
            boolean finished = latch.await(25, TimeUnit.SECONDS);
            if (finished && failure.get() == null && audioBuf.size() > 1000) {
                FileOutputStream out = new FileOutputStream(outMp3);
                out.write(audioBuf.toByteArray());
                out.close();
                return new Result(true, false, 0);
            }
            long skew = retrySkew.get();
            boolean canAdjust = skew != Long.MIN_VALUE;
            Log.w(TAG, "synth failed: finished=" + finished + " err=" + failure.get() +
                    " size=" + audioBuf.size() + " canAdjust=" + canAdjust);
            if (canAdjust) return new Result(false, true, skew);
            return new Result(false, false, 0);
        } catch (Exception e) {
            Log.w(TAG, "synth exception", e);
            return new Result(false, false, 0);
        }
    }

    /**
     * 生成 Sec-MS-GEC：Windows 文件时间戳（100ns 间隔）向下取整到最近 5 分钟，
     * 与 TrustedClientToken 无分隔符拼接后做 SHA-256（大写十六进制）。
     */
    private static String generateSecMsGec(long skewMs) {
        try {
            long unix = (System.currentTimeMillis() + skewMs) / 1000L;
            long ticks = unix + WIN_EPOCH_SECONDS;
            ticks -= ticks % 300L;
            ticks *= 10000000L;
            return sha256Upper(ticks + TRUSTED_CLIENT_TOKEN);
        } catch (Exception e) {
            return "";
        }
    }

    private static String sha256Upper(String input) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] hash = md.digest(input.getBytes("UTF-8"));
        StringBuilder sb = new StringBuilder(hash.length * 2);
        for (byte b : hash) {
            sb.append(Character.toUpperCase(Character.forDigit((b >> 4) & 0xF, 16)));
            sb.append(Character.toUpperCase(Character.forDigit(b & 0xF, 16)));
        }
        return sb.toString();
    }

    /** 生成随机的 muid（32 位大写十六进制），作为 Cookie 值。 */
    private static String generateMuid() {
        SecureRandom r = new SecureRandom();
        byte[] b = new byte[16];
        r.nextBytes(b);
        StringBuilder sb = new StringBuilder(32);
        for (byte x : b) {
            sb.append(Character.toUpperCase(Character.forDigit((x >> 4) & 0xF, 16)));
            sb.append(Character.toUpperCase(Character.forDigit(x & 0xF, 16)));
        }
        return sb.toString();
    }

    /** 与 edge-tts connect_id() 一致：无连字符的小写 UUID。 */
    private static String connectId() {
        return UUID.randomUUID().toString().replace("-", "").toLowerCase(Locale.US);
    }

    /** edge-tts date_to_string()：GMT+0000 (Coordinated Universal Time) 格式。 */
    private static String timestamp() {
        SimpleDateFormat fmt = new SimpleDateFormat(
                "EEE MMM dd yyyy HH:mm:ss 'GMT+0000 (Coordinated Universal Time)'", Locale.US);
        fmt.setTimeZone(TimeZone.getTimeZone("GMT"));
        return fmt.format(new Date());
    }

    /** 解析 HTTP 响应头 Date（RFC 1123 格式），返回 Unix 秒，失败返回 null。 */
    private static Long parseHttpDate(String s) {
        try {
            SimpleDateFormat fmt = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US);
            fmt.setTimeZone(TimeZone.getTimeZone("GMT"));
            fmt.setLenient(false);
            return fmt.parse(s).getTime() / 1000L;
        } catch (Exception e) {
            return null;
        }
    }

    /** 移除服务不支持的 ASCII 控制字符（同 edge-tts remove_incompatible_characters）。 */
    private static String sanitize(String s) {
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            int c = s.charAt(i);
            if ((c >= 0 && c <= 8) || (c >= 11 && c <= 12) || (c >= 14 && c <= 31)) sb.append(' ');
            else sb.append((char) c);
        }
        return sb.toString();
    }

    private static String escapeXml(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;").replace("'", "&apos;");
    }
}
