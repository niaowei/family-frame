/*
 * 相框设置页（家人用，不在奶奶主屏）：
 * - 服务器地址 + 设备令牌配置（保存即同步）
 * - 立即同步；库统计与上次同步结果
 * - 储存卡备份 / 恢复（Backup）
 * - 相框显示设备码，管理员在手机输入；已绑定设备不重复配对
 * - 能力测试入口（E1 验收工具）
 * 奶奶主界面见 FrameActivity。
 */

package com.familyframe.capability;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.HashSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

public class ConfigActivity extends Activity {
    private static final int REQ_BACKUP_TREE = 21;
    private static final int REQ_RESTORE_TREE = 22;

    private FrameStore store;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private EditText baseInput, tokenInput;
    private TextView statusView;
    private final Handler pairHandler = new Handler(Looper.getMainLooper());
    private AlertDialog pairDialog;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        store = FrameStore.get(this);
        buildUi();
        refreshStatus();
    }

    private TextView label(String s, float size, int color) {
        TextView v = new TextView(this);
        v.setText(s);
        v.setTextColor(color);
        v.setTextSize(size);
        v.setPadding(0, 24, 0, 8);
        return v;
    }

    private Button button(String s, View.OnClickListener click) {
        Button b = new Button(this);
        b.setText(s);
        b.setTextSize(18);
        b.setOnClickListener(click);
        return b;
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(32, 40, 32, 40);
        root.setBackgroundColor(0xFF0B1120);
        int text = 0xFFF8FAFC, subtle = 0xFF94A3B8;

        root.addView(label("家庭语音相框 · 设置", 24, text));

        root.addView(label("服务器地址（家人发送页的网址）", 15, subtle));
        baseInput = new EditText(this);
        baseInput.setTextColor(text);
        baseInput.setHintTextColor(subtle);
        baseInput.setHint("https://xxx.sealos.run 或 http://192.168.x.x:3000");
        baseInput.setText(FrameConfig.baseUrl(this));
        root.addView(baseInput);

        root.addView(label("设备令牌（长串字符，来自家庭初始化）", 15, subtle));
        tokenInput = new EditText(this);
        tokenInput.setTextColor(text);
        tokenInput.setHintTextColor(subtle);
        tokenInput.setHint("粘贴令牌，或用下方短码配对");
        tokenInput.setText(FrameConfig.token(this));
        root.addView(tokenInput);

        LinearLayout row1 = new LinearLayout(this);
        row1.setOrientation(LinearLayout.HORIZONTAL);
        Button save = button("保存并同步", v -> {
            FrameConfig.save(this, baseInput.getText().toString(), tokenInput.getText().toString());
            refreshStatus();
            toast("已保存");
            if (FrameConfig.configured(this)) syncNow();
        });
        Button pair = button("显示设备配对码", v -> showPairDialog());
        row1.addView(save, new LinearLayout.LayoutParams(0, -2, 1f));
        row1.addView(pair, new LinearLayout.LayoutParams(0, -2, 1f));
        root.addView(row1);

        root.addView(label("库状态", 15, subtle));
        statusView = label("", 15, text);
        root.addView(statusView);

        Button sync = button("立即同步", v -> {
            if (!FrameConfig.configured(this)) {
                toast("请先填写服务器地址和令牌");
                return;
            }
            syncNow();
        });
        root.addView(sync);

        root.addView(label("储存卡备份（含照片/录音/留言，不含令牌）", 15, subtle));
        LinearLayout row2 = new LinearLayout(this);
        row2.setOrientation(LinearLayout.HORIZONTAL);
        Button backup = button("导出到储存卡", v -> pickTree(REQ_BACKUP_TREE));
        Button restore = button("从储存卡恢复", v -> pickTree(REQ_RESTORE_TREE));
        row2.addView(backup, new LinearLayout.LayoutParams(0, -2, 1f));
        row2.addView(restore, new LinearLayout.LayoutParams(0, -2, 1f));
        root.addView(row2);

        root.addView(label("诊断", 15, subtle));
        Button capability = button("打开能力测试（E1 工具）", v ->
                startActivity(new Intent(this, MainActivity.class)));
        root.addView(capability);

        Button back = button("返回相框", v -> finish());
        root.addView(back);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(root, new ScrollView.LayoutParams(-1, -2));
        setContentView(scroll);
    }

    private void pickTree(int req) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        startActivityForResult(i, req);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri treeUri = data.getData();
        try {
            getContentResolver().takePersistableUriPermission(treeUri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception ignored) {
        }
        if (requestCode == REQ_BACKUP_TREE) {
            final FrameStore st = store;
            io.execute(() -> {
                final Backup.Summary s = Backup.export(this, treeUri, st);
                runOnUiThread(() -> {
                    if (s.ok) toast("备份完成：" + s.dirName + "（" + s.files + " 个文件已核验）");
                    else toast(s.error == null ? "备份失败" : s.error);
                    refreshStatus();
                });
            });
        } else if (requestCode == REQ_RESTORE_TREE) {
            final FrameStore st = store;
            io.execute(() -> {
                final Backup.Summary s = Backup.restore(this, treeUri, st);
                runOnUiThread(() -> {
                    if (s.ok) toast("恢复完成：新增 " + s.restoredPosts + " 条（跳过已有 " + s.skippedPosts + " 条）");
                    else toast(s.error == null ? "恢复失败" : s.error);
                    refreshStatus();
                });
            });
        }
    }

    private void refreshStatus() {
        if (statusView == null) return;
        StringBuilder sb = new StringBuilder();
        sb.append(FrameConfig.describe(this)).append('\n');
        sb.append(store.statsLine()).append('\n');
        long last = store.lastSyncAt();
        sb.append("上次同步：").append(last > 0
                ? new java.text.SimpleDateFormat("M月d日 HH:mm", java.util.Locale.CHINA).format(new java.util.Date(last)) : "从未");
        if (!store.lastSyncNote().isEmpty()) sb.append("｜").append(store.lastSyncNote());
        statusView.setText(sb.toString());
    }

    private void syncNow() {
        statusView.setText("正在同步…");
        io.execute(() -> {
            SyncEngine engine = new SyncEngine(store, FrameConfig.baseUrl(this), FrameConfig.token(this));
            final SyncEngine.Result r = engine.sync(new HashSet<>(), appVersion());
            runOnUiThread(() -> {
                toast(r.summary());
                refreshStatus();
            });
        });
    }

    private String appVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "unknown";
        }
    }

    /** 私有凭证只保存在相框。断网、重开或响应丢失后，使用相同凭证查询绑定结果。 */
    private void showPairDialog() {
        final String base = baseInput.getText().toString().trim().replaceAll("/+$", "");
        if (FrameConfig.configured(this)) {
            toast("相框已绑定，家人换手机或重新登录都不需要再次绑定");
            return;
        }
        Uri uri = Uri.parse(base);
        if (!("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) || uri.getHost() == null) {
            toast("请先填写服务器地址");
            return;
        }
        android.content.SharedPreferences pending = getSharedPreferences("frame_pair_pending", MODE_PRIVATE);
        String token = pending.getString("base", "").equals(base) ? pending.getString("token", "") : "";
        if (token.isEmpty()) {
            byte[] bytes = new byte[32];
            new java.security.SecureRandom().nextBytes(bytes);
            StringBuilder hex = new StringBuilder();
            for (byte b : bytes) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
            token = hex.toString();
            if (!pending.edit().putString("base", base).putString("token", token).commit()) {
                toast("无法保存配对信息，请检查设备空间"); return;
            }
        }
        final String deviceToken = token;
        final TextView display = label("正在获取设备码…", 24, android.graphics.Color.BLACK);
        display.setGravity(Gravity.CENTER);
        final AlertDialog dialog = new AlertDialog.Builder(this).setTitle("用手机绑定这台相框")
                .setView(display).setNegativeButton("关闭", null).create();
        pairDialog = dialog;
        dialog.setOnDismissListener(d -> pairHandler.removeCallbacksAndMessages(null));
        dialog.show();
        pairRequest(base, deviceToken, true, dialog, display);
    }

    private void pairRequest(String base, String token, boolean start, AlertDialog dialog, TextView display) {
        if (!dialog.isShowing() || isFinishing() || isDestroyed()) return;
        io.execute(() -> {
            try {
                OkHttpClient http = new OkHttpClient.Builder().callTimeout(15, java.util.concurrent.TimeUnit.SECONDS).build();
                JSONObject body = new JSONObject();
                body.put("deviceToken", token);
                Request req = new Request.Builder()
                        .url(base + (start ? "/api/pair/start" : "/api/pair/status"))
                        .post(RequestBody.create(MediaType.parse("application/json"), body.toString()))
                        .build();
                try (Response res = http.newCall(req).execute()) {
                    String text = res.body() == null ? "" : res.body().string();
                    JSONObject out = new JSONObject(text);
                    runOnUiThread(() -> {
                        if (!dialog.isShowing() || isFinishing() || isDestroyed()) return;
                        if (!res.isSuccessful()) {
                            display.setText(out.optString("message", "连接失败，请关闭后重试")); return;
                        }
                        if (out.optBoolean("paired")) {
                            if (!FrameConfig.save(this, base, token)) {
                                display.setText("已绑定，但保存失败。请检查设备空间后重新打开，绑定信息可以恢复。"); return;
                            }
                            baseInput.setText(base);
                            tokenInput.setText(token);
                            getSharedPreferences("frame_pair_pending", MODE_PRIVATE).edit().clear().apply();
                            dialog.dismiss();
                            toast("绑定成功，以后无需重复绑定");
                            syncNow();
                            return;
                        }
                        if (out.optBoolean("expired")) { display.setText("设备码已过期，请关闭后重新获取"); return; }
                        if (start) display.setText(out.optString("code") + "\n\n请管理员在手机网页“家庭 → 绑定奶奶的相框”输入这 6 位数字。\n5 分钟内有效。奶奶无需操作。");
                        pairHandler.postDelayed(() -> pairRequest(base, token, false, dialog, display), 3000);
                    });
                }
            } catch (Exception e) {
                runOnUiThread(() -> {
                    if (!dialog.isShowing() || isFinishing() || isDestroyed()) return;
                    if (start) display.setText("连接失败，请关闭后重试；已有绑定结果不会丢失");
                    else pairHandler.postDelayed(() -> pairRequest(base, token, false, dialog, display), 5000);
                });
            }
        });
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (pairDialog != null) pairDialog.dismiss();
        pairHandler.removeCallbacksAndMessages(null);
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }
}

