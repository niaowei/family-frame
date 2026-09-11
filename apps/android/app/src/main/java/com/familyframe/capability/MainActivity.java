package com.familyframe.capability;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.media.MediaPlayer;
import android.media.MediaRecorder;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import com.reecedunn.espeak.SpeechSynthesis;

public class MainActivity extends Activity {
    private static final int RECORD_PERMISSION = 7;
    private static final int PICK_TREE = 8;
    private TextView status;
    private MediaRecorder recorder;
    private MediaPlayer player;
    private File recording;
    private SpeechSynthesis espeak;
    private MsTts msTts;
    private volatile boolean espeakReady = false;
    private volatile java.io.ByteArrayOutputStream pcmSink;
    private Thread synthThread;
    private android.media.AudioTrack playingTrack;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        // requestFeature 必须在内容添加前调用一次；immersive() 可被“重新全屏”按钮在内容添加后再次调用
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        immersive();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        recording = new File(getFilesDir(), "frame-test/voice.m4a");
        recording.getParentFile().mkdirs();
        msTts = new MsTts();
        initEspeakAsync();
        buildUi();
    }

    /** 后台解压语音数据并初始化内置 eSpeakNG 引擎（首启约需几秒）。 */
    private void initEspeakAsync() {
        setStatus("离线语音初始化中…");
        new Thread(() -> {
            try {
                File root = extractVoiceData();
                final SpeechSynthesis s = new SpeechSynthesis(root.getPath(), new SpeechSynthesis.SynthReadyCallback() {
                    @Override public void onSynthDataReady(byte[] data) { java.io.ByteArrayOutputStream sink = pcmSink; if (sink != null) sink.write(data, 0, data.length); }
                    @Override public void onSynthDataComplete() {}
                    @Override public void onSynthWordBoundary(int a, int b, int c) {}
                });
                final boolean ok = s.isInitialized() && s.setVoiceByName("cmn");
                runOnUiThread(() -> { espeak = s; espeakReady = ok; setStatus(ok ? "离线中文语音已就绪（eSpeakNG，点击中文 TTS 测试）" : "离线语音初始化失败（原生库）"); });
            } catch (Exception e) {
                runOnUiThread(() -> setStatus("离线语音初始化失败：" + e.getClass().getSimpleName()));
            }
        }).start();
    }

    /** 将内置的语音数据 ZIP 解压到 app_voices/espeak-ng-data（仅首次）。 */
    private File extractVoiceData() throws Exception {
        File root = getDir("voices", MODE_PRIVATE);
        if (!new File(root, "espeak-ng-data/phontab").exists()) {
            ZipInputStream zip = new ZipInputStream(getResources().openRawResource(R.raw.espeakdata));
            byte[] buf = new byte[16384];
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                File f = new File(root, entry.getName());
                if (entry.isDirectory()) { f.mkdirs(); continue; }
                f.getParentFile().mkdirs();
                FileOutputStream out = new FileOutputStream(f);
                int n;
                while ((n = zip.read(buf)) != -1) out.write(buf, 0, n);
                out.close();
                zip.closeEntry();
            }
            zip.close();
        }
        return root;
    }

    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN |
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    private TextView label(String text, int size) {
        TextView v = new TextView(this); v.setText(text); v.setTextColor(0xfff8fafc); v.setTextSize(size); v.setPadding(18, 12, 18, 12); return v;
    }

    private Button button(String text, View.OnClickListener click) {
        Button b = new Button(this); b.setText(text); b.setTextSize(18); b.setMinHeight(64); b.setOnClickListener(click); return b;
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(18, 14, 18, 18); root.setBackgroundColor(0xff020617);
        TextView title = label("家庭语音相框 · 能力测试", 26); title.setGravity(Gravity.CENTER); root.addView(title, new LinearLayout.LayoutParams(-1, -2));
        ImageView photo = new ImageView(this); photo.setImageResource(R.drawable.test_photo); photo.setScaleType(ImageView.ScaleType.CENTER_INSIDE); root.addView(photo, new LinearLayout.LayoutParams(-1, 0, 1));
        TextView hint = label("内置测试图｜随设备旋转｜前台常亮\n先测声音，再测本地保存和储存卡", 16); hint.setGravity(Gravity.CENTER); root.addView(hint);
        LinearLayout row1 = new LinearLayout(this); row1.setOrientation(LinearLayout.HORIZONTAL);
        row1.addView(button("播放提示音", v -> playTone()), new LinearLayout.LayoutParams(0, -2, 1));
        row1.addView(button("中文 TTS", v -> speak()), new LinearLayout.LayoutParams(0, -2, 1));
        row1.addView(button("录音/回放", v -> recordOrPlay()), new LinearLayout.LayoutParams(0, -2, 1)); root.addView(row1);
        LinearLayout row2 = new LinearLayout(this); row2.setOrientation(LinearLayout.HORIZONTAL);
        row2.addView(button("保存并读回", v -> persistTest()), new LinearLayout.LayoutParams(0, -2, 1));
        row2.addView(button("选择储存卡", v -> chooseTree()), new LinearLayout.LayoutParams(0, -2, 1));
        row2.addView(button("重新全屏", v -> immersive()), new LinearLayout.LayoutParams(0, -2, 1)); root.addView(row2);
        status = label("状态：等待测试", 17); status.setGravity(Gravity.CENTER); root.addView(status);
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(root, new ScrollView.LayoutParams(-1, -2));
        setContentView(scroll);
    }

    private void setStatus(String s) { if (status != null) status.setText("状态：" + s); }

    private void playTone() {
        final int sampleRate = 44100, seconds = 1; short[] data = new short[sampleRate * seconds];
        for (int i = 0; i < data.length; i++) data[i] = (short)(Math.sin(2 * Math.PI * 660 * i / sampleRate) * 14000);
        android.media.AudioTrack track = new android.media.AudioTrack(android.media.AudioManager.STREAM_MUSIC, sampleRate, android.media.AudioFormat.CHANNEL_OUT_MONO, android.media.AudioFormat.ENCODING_PCM_16BIT, data.length * 2, android.media.AudioTrack.MODE_STATIC);
        track.write(data, 0, data.length); track.play(); setStatus("提示音已调用，请确认相框实际听见声音");
    }

    private void speak() {
        if (synthThread != null && synthThread.isAlive()) { setStatus("正在播报，请稍候"); return; }
        stopTrack();
        stopPlayer();
        synthThread = new Thread(() -> {
            final String text = "这是家庭语音相框的中文测试。请确认您实际听到了声音。";
            // 优先：微软在线神经语音（联网）
            File mp3 = new File(getFilesDir(), "frame-test/ms.mp3");
            boolean msOk = false;
            try { msOk = msTts.synthesize(text, "zh-CN-XiaoxiaoNeural", mp3); } catch (Exception ignored) {}
            if (msOk && mp3.length() > 2000) {
                runOnUiThread(() -> { setStatus("微软语音（联网）合成成功，正在播放"); playMp3(mp3); });
                return;
            }
            // 兜底：内置离线 eSpeakNG
            final SpeechSynthesis s = espeak;
            if (s == null || !espeakReady) { runOnUiThread(() -> setStatus("联网语音失败且离线引擎未就绪，请检查网络")); return; }
            pcmSink = new java.io.ByteArrayOutputStream();
            boolean ok;
            try { ok = s.synthesize(text, false); } catch (Exception e) { ok = false; }
            byte[] pcm = pcmSink.toByteArray();
            pcmSink = null;
            if (ok && pcm.length > 0) playPcm(s.getSampleRate(), pcm);
            final boolean good = ok && pcm.length > 0;
            runOnUiThread(() -> setStatus(good ? "联网语音不可用，已改用离线语音（eSpeakNG）播报" : "语音合成失败，无声音输出"));
        }, "voice-synth");
        synthThread.start();
    }

    private void playMp3(File mp3) {
        stopPlayer();
        player = MediaPlayer.create(this, Uri.fromFile(mp3));
        if (player == null) { setStatus("语音文件无法播放（可能未合成成功）"); return; }
        player.setOnCompletionListener(p -> { setStatus("微软语音播报完成"); stopPlayer(); });
        player.start();
    }

    private void playPcm(int sampleRate, byte[] pcm) {
        try {
            playingTrack = new android.media.AudioTrack(android.media.AudioManager.STREAM_MUSIC, sampleRate, android.media.AudioFormat.CHANNEL_OUT_MONO, android.media.AudioFormat.ENCODING_PCM_16BIT, pcm.length, android.media.AudioTrack.MODE_STATIC);
            playingTrack.write(pcm, 0, pcm.length);
            playingTrack.play();
        } catch (Exception e) { stopTrack(); }
    }

    private void stopTrack() { if (playingTrack != null) { try { playingTrack.stop(); } catch (Exception ignored) {} playingTrack.release(); playingTrack = null; } }

    private void recordOrPlay() {
        if (recorder != null) { try { recorder.stop(); } catch (Exception ignored) {} recorder.release(); recorder = null; setStatus("录音已保存，再点一次播放"); return; }
        if (recording.exists()) { stopPlayer(); player = MediaPlayer.create(this, Uri.fromFile(recording)); if (player == null) { setStatus("录音文件无法打开"); return; } player.setOnCompletionListener(p -> setStatus("录音播放完成")); player.start(); setStatus("正在播放已保存录音"); return; }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, RECORD_PERMISSION); return; }
        try { recorder = new MediaRecorder(); recorder.setAudioSource(MediaRecorder.AudioSource.MIC); recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4); recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC); recorder.setOutputFile(recording); recorder.prepare(); recorder.start(); setStatus("正在录音，再点一次停止"); } catch (Exception e) { setStatus("录音启动失败：" + e.getClass().getSimpleName()); recorder = null; }
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) { super.onRequestPermissionsResult(request, permissions, results); if (request == RECORD_PERMISSION && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) { setStatus("已获得麦克风权限，再点录音/回放开始"); } else setStatus("未获得麦克风权限，录音未执行"); }

    private void persistTest() {
        try { File dir = new File(getFilesDir(), "frame-test"); dir.mkdirs(); File image = new File(dir, "test-photo.png"); Bitmap b = drawableBitmap(R.drawable.test_photo); try (FileOutputStream out = new FileOutputStream(image)) { if (!b.compress(Bitmap.CompressFormat.PNG, 100, out)) throw new java.io.IOException("bitmap compress failed"); } b.recycle(); File marker = new File(dir, "manifest.txt"); try (FileOutputStream m = new FileOutputStream(marker)) { m.write("family-frame capability v0.1.0\nphoto=test-photo.png\nvoice=voice.m4a\n".getBytes(StandardCharsets.UTF_8)); } byte[] read = read(marker); setStatus(read.length > 0 && image.length() > 0 ? "原生持久目录写入/读回通过（" + image.length() + " bytes）" : "读回为空"); } catch (Exception e) { setStatus("持久化失败：" + e.getClass().getSimpleName()); }
    }

    private Bitmap drawableBitmap(int resourceId) {
        Drawable drawable = getDrawable(resourceId);
        int size = Math.max(1, drawable.getIntrinsicWidth());
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        drawable.setBounds(0, 0, size, size);
        drawable.draw(new Canvas(bitmap));
        return bitmap;
    }

    private byte[] read(File file) throws Exception { FileInputStream in = new FileInputStream(file); byte[] b = new byte[(int)file.length()]; int n = in.read(b); in.close(); return n == b.length ? b : new byte[0]; }

    private void chooseTree() { Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE); i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION); startActivityForResult(i, PICK_TREE); }

    @Override protected void onActivityResult(int request, int result, Intent data) { super.onActivityResult(request, result, data); if (request != PICK_TREE || result != RESULT_OK || data == null) { if (request == PICK_TREE) setStatus("未选择储存卡目录"); return; } Uri tree = data.getData(); try { getContentResolver().takePersistableUriPermission(tree, data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION)); Uri file = android.provider.DocumentsContract.createDocument(getContentResolver(), tree, "text/plain", "family-frame-card-test.txt"); OutputStream out = getContentResolver().openOutputStream(file); out.write("储存卡读写测试通过".getBytes(StandardCharsets.UTF_8)); out.close(); InputStream in = getContentResolver().openInputStream(file); byte[] buf = new byte[64]; int n = in.read(buf); in.close(); setStatus(n > 0 ? "储存卡写入/读回通过" : "储存卡读回为空"); } catch (Exception e) { setStatus("储存卡测试失败：" + e.getClass().getSimpleName()); } }

    private void stopPlayer() { if (player != null) { try { player.stop(); } catch (Exception ignored) {} player.release(); player = null; } }
    @Override protected void onDestroy() { stopPlayer(); stopTrack(); if (recorder != null) { try { recorder.stop(); } catch (Exception ignored) {} recorder.release(); recorder = null; } if (espeak != null) { try { espeak.stop(); } catch (Exception ignored) {} } super.onDestroy(); }
}
