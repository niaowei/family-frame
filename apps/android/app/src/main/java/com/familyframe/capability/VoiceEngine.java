/*
 * 留言播报引擎（E2）：真人录音优先，无录音时中文 TTS（微软在线 → eSpeakNG 离线兜底）。
 * 播放优先级与 Web 端 playback.ts 一致：
 *   1. 真人 voice 媒体
 *   2. 「这是{成员}发来的照片。{留言}」TTS
 *   3. 无声音
 * 任意时刻只允许一个声音：每次 play 前 stop，用序列号防止旧播放的回调串音。
 */

package com.familyframe.capability;

import android.content.Context;
import android.media.AudioTrack;
import android.media.MediaPlayer;
import android.net.Uri;
import android.util.Log;

import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import com.reecedunn.espeak.SpeechSynthesis;

public class VoiceEngine {
    private static final String TAG = "VoiceEngine";

    public interface Callback {
        /** 实际发声结束（无论哪一级）。audible=false 表示最终没有可播内容 */
        void onFinish(boolean audible);

        default void onStart() {}
    }

    private final Context ctx;
    private final MsTts msTts;
    private final ExecutorService synth = Executors.newSingleThreadExecutor();
    private final AtomicInteger seq = new AtomicInteger(0);

    private volatile SpeechSynthesis espeak;
    private volatile boolean espeakReady = false;
    private volatile java.io.ByteArrayOutputStream pcmSink;

    private MediaPlayer player;
    private AudioTrack track;
    private volatile boolean playing = false;

    public VoiceEngine(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.msTts = new MsTts();
        initEspeakAsync();
    }

    /** 后台解压语音数据并初始化 eSpeakNG（首启几秒；不可用时仅影响离线兜底） */
    private void initEspeakAsync() {
        new Thread(() -> {
            try {
                File root = extractVoiceData();
                final SpeechSynthesis s = new SpeechSynthesis(root.getPath(), new SpeechSynthesis.SynthReadyCallback() {
                    @Override public void onSynthDataReady(byte[] data) {
                        java.io.ByteArrayOutputStream sink = pcmSink;
                        if (sink != null) sink.write(data, 0, data.length);
                    }
                    @Override public void onSynthDataComplete() {}
                    @Override public void onSynthWordBoundary(int a, int b, int c) {}
                });
                boolean ok = s.isInitialized() && s.setVoiceByName("cmn");
                espeak = s;
                espeakReady = ok;
                Log.i(TAG, "eSpeakNG 离线兜底就绪=" + ok);
            } catch (Exception e) {
                Log.w(TAG, "eSpeakNG 初始化失败: " + e);
            }
        }, "voice-engine-init").start();
    }

    private File extractVoiceData() throws Exception {
        File root = ctx.getDir("voices", Context.MODE_PRIVATE);
        if (!new File(root, "espeak-ng-data/phontab").exists()) {
            ZipInputStream zip = new ZipInputStream(ctx.getResources().openRawResource(R.raw.espeakdata));
            byte[] buf = new byte[16384];
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                File f = new File(root, entry.getName());
                if (entry.isDirectory()) { f.mkdirs(); continue; }
                f.getParentFile().mkdirs();
                java.io.FileOutputStream out = new java.io.FileOutputStream(f);
                int n;
                while ((n = zip.read(buf)) != -1) out.write(buf, 0, n);
                out.close();
                zip.closeEntry();
            }
            zip.close();
        }
        return root;
    }

    public boolean isPlaying() {
        return playing;
    }

    /** 停止当前一切发声（真人/TTS 均含），并作废旧回调 */
    public void stop() {
        seq.incrementAndGet();
        playing = false;
        stopPlayer();
        stopTrack();
    }

    private void stopPlayer() {
        try {
            if (player != null) {
                player.stop();
                player.release();
            }
        } catch (Exception ignored) {
        }
        player = null;
    }

    private void stopTrack() {
        try {
            if (track != null) {
                track.stop();
                track.release();
            }
        } catch (Exception ignored) {
        }
        track = null;
    }

    /** 播放真人录音文件（本地已落盘的 VOICE 媒体）。 */
    public void playVoice(File file, Callback cb) {
        stop();
        final int mySeq = seq.get();
        playing = true;
        cb.onStart();
        try {
            player = MediaPlayer.create(ctx, Uri.fromFile(file));
            if (player == null) {
                playing = false;
                cb.onFinish(false);
                return;
            }
            player.setOnCompletionListener(p -> {
                playing = false;
                if (seq.get() == mySeq) cb.onFinish(true);
            });
            player.start();
        } catch (Exception e) {
            Log.w(TAG, "真人录音播放失败: " + e);
            playing = false;
            cb.onFinish(false);
        }
    }

    /** 播报文本：微软在线 TTS 优先，eSpeakNG 离线兜底；都失败回调 audible=false。 */
    public void speakText(String text, Callback cb) {
        stop();
        final int mySeq = seq.get();
        playing = true;
        cb.onStart();
        synth.submit(() -> {
            final String safe = text == null ? "" : text.trim();
            if (safe.isEmpty()) {
                playing = false;
                cb.onFinish(false);
                return;
            }
            // 1) 微软在线神经语音
            File mp3 = new File(ctx.getFilesDir(), "library/.tts-cache.mp3");
            boolean msOk = false;
            try {
                if (mp3.getParentFile() != null) mp3.getParentFile().mkdirs();
                msOk = msTts.synthesize(safe, "zh-CN-XiaoxiaoNeural", mp3);
            } catch (Exception ignored) {
            }
            if (msOk && mp3.length() > 2000 && seq.get() == mySeq) {
                playMp3AndWait(mp3, mySeq, cb);
                return;
            }
            // 2) 离线 eSpeakNG
            if (seq.get() != mySeq) {
                playing = false;
                return;
            }
            SpeechSynthesis s = espeak;
            if (s == null || !espeakReady) {
                playing = false;
                cb.onFinish(false);
                return;
            }
            pcmSink = new java.io.ByteArrayOutputStream();
            boolean ok;
            try {
                ok = s.synthesize(safe, false);
            } catch (Exception e) {
                ok = false;
            }
            byte[] pcm = pcmSink.toByteArray();
            pcmSink = null;
            if (seq.get() != mySeq) {
                playing = false;
                return;
            }
            if (ok && pcm.length > 0) {
                playPcm(s.getSampleRate(), pcm, mySeq, cb);
            } else {
                playing = false;
                cb.onFinish(false);
            }
        });
    }

    private void playMp3AndWait(File mp3, int mySeq, Callback cb) {
        try {
            MediaPlayer p = MediaPlayer.create(ctx, Uri.fromFile(mp3));
            if (p == null) {
                playing = false;
                cb.onFinish(false);
                return;
            }
            final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
            p.setOnCompletionListener(mp -> latch.countDown());
            p.start();
            latch.await(30, java.util.concurrent.TimeUnit.SECONDS);
            p.release();
            playing = false;
            if (seq.get() == mySeq) cb.onFinish(true);
        } catch (Exception e) {
            Log.w(TAG, "TTS 播放失败: " + e);
            playing = false;
            if (seq.get() == mySeq) cb.onFinish(false);
        }
    }

    private void playPcm(int sampleRate, byte[] pcm, int mySeq, Callback cb) {
        try {
            track = new AudioTrack(android.media.AudioManager.STREAM_MUSIC, sampleRate,
                    android.media.AudioFormat.CHANNEL_OUT_MONO, android.media.AudioFormat.ENCODING_PCM_16BIT,
                    pcm.length, AudioTrack.MODE_STATIC);
            track.write(pcm, 0, pcm.length);
            track.play();
            // 等待播放完成（静态模式：按字节长度估算）
            long durationMs = pcm.length * 1000L / (sampleRate * 2);
            long endAt = System.currentTimeMillis() + durationMs + 500;
            while (System.currentTimeMillis() < endAt && seq.get() == mySeq) {
                Thread.sleep(100);
            }
            playing = false;
            if (seq.get() == mySeq) cb.onFinish(pcm.length > 0);
        } catch (Exception e) {
            Log.w(TAG, "离线播放失败: " + e);
            playing = false;
            if (seq.get() == mySeq) cb.onFinish(false);
        }
    }

    /** TTS 播报文案（与 Web 端 playback.buildTtsText 一致） */
    public static String buildTtsText(String memberName, String messageText) {
        String message = messageText == null ? "" : messageText.trim();
        if (message.isEmpty()) return null;
        return "这是" + memberName + "发来的照片。" + message;
    }
}
