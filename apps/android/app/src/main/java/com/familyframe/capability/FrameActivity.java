/*
 * 相框主界面（E2 业务版，奶奶日常唯一入口）。
 *
 * 交互约定（与执行单一致）：
 * - 全屏沉浸、随设备横竖旋转、前台常亮；
 * - 奶奶只需三个按钮：上一张／播放声音／下一张；点击照片中央同样播放；
 * - 真人录音优先，无录音时中文 TTS（微软在线→eSpeakNG 离线）；
 * - 默认点击发声：到达新图或 20 分钟轮播换图都不自动发声；
 * - 最后一次操作 20 分钟后开始换图，之后每 20 分钟一张；播放与加载期间不换图；
 * - 照片优先显示（与 Web 端一致），纯视频 post 播视频（无声自动播放，结束定格；
 *   点“播放声音”优先录音/TTS，二者皆无则重开视频放它的原声）；
 * - 大字留言 + 发送者可见；无技术错误文案；
 * - 右上角极小的“设置”入口供家人使用。
 */

package com.familyframe.capability;

import android.app.Activity;
import android.animation.ValueAnimator;
import android.content.Intent;
import android.graphics.Color;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.VideoView;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.TransitionDrawable;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class FrameActivity extends Activity {
    private static final String TAG = "FrameActivity";
    private static final long CAROUSEL_IDLE_MS = 20 * 60 * 1000L;
    private static final long CAROUSEL_INTERVAL_MS = 20 * 60 * 1000L;
    private static final long SYNC_PERIOD_MS = 30 * 60 * 1000L;
    private static final long SEEN_AFTER_MS = 2000L;
    private static final int BG = 0xFF111A19;
    private static final int TEXT = 0xFFF4FAF7;
    private static final int SUBTLE = 0xFFB9C9C1;
    private static final int ACCENT = 0xFFF3C968;
    private static final int BUTTON = 0xFF24332D;
    private static final int BUTTON_BORDER = 0xFF3B4A44;

    private FrameStore store;
    private VoiceEngine voice;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    // 视图
    private ImageView photoView;
    private VideoView videoView;
    private TextView emptyView;
    private TextView senderView;
    private TextView messageView;
    private Button playBtn;

    // 状态（主线程）
    private List<FrameStore.Post> posts = java.util.Collections.emptyList();
    private int index = -1;
    private int photoIndex = 0;
    private boolean videoActive = false;
    private long lastActivityAt = 0;
    private boolean autoAdvance = false;
    private String shownPostId = null;
    private boolean loading = false;
    private final Set<String> pendingSeen = new HashSet<>();

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // requestFeature 必须在内容添加前调用一次；immersive() 会在 onResume 等阶段重复调用
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        immersive();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        store = FrameStore.get(this);
        voice = new VoiceEngine(this);
        buildUi();
        reloadPosts(true);
        scheduleSync(0);
    }

    @Override
    protected void onResume() {
        super.onResume();
        immersive();
        reloadPosts(true);
        syncNow("onResume");
        scheduleSync(SYNC_PERIOD_MS);
    }

    @Override
    protected void onPause() {
        super.onPause();
        main.removeCallbacks(syncTick);
        stopPlayback();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    // ---------------- UI 构建 ----------------

    private TextView text(String s, float size, int color) {
        TextView v = new TextView(this);
        v.setText(s);
        v.setTextColor(color);
        v.setTextSize(size);
        return v;
    }

    private Button bigButton(String s, int bgColor, View.OnClickListener click) {
        Button b = new Button(this);
        b.setText(s);
        b.setTextSize(24);
        b.setTextColor(bgColor == ACCENT ? 0xFF253027 : TEXT);
        GradientDrawable background = new GradientDrawable();
        background.setColor(bgColor);
        background.setCornerRadius(dp(15));
        background.setStroke(dp(1), bgColor == ACCENT ? ACCENT : BUTTON_BORDER);
        b.setBackground(background);
        b.setAllCaps(false);
        b.setGravity(Gravity.CENTER);
        b.setMinHeight(dp(88));
        b.setOnClickListener(click);
        return b;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void buildUi() {
        FrameLayout outer = new FrameLayout(this);
        outer.setBackgroundColor(BG);

        LinearLayout mainCol = new LinearLayout(this);
        mainCol.setOrientation(LinearLayout.VERTICAL);
        outer.addView(mainCol, new FrameLayout.LayoutParams(-1, -1));

        // 媒体区
        photoView = new ImageView(this);
        photoView.setScaleType(ImageView.ScaleType.FIT_CENTER);
        photoView.setBackgroundColor(BG);
        videoView = new VideoView(this);
        videoView.setVisibility(View.GONE);
        emptyView = text("家人的照片会出现在这里", 26, SUBTLE);
        emptyView.setGravity(Gravity.CENTER);
        emptyView.setVisibility(View.GONE);

        FrameLayout mediaFrame = new FrameLayout(this);
        mediaFrame.addView(photoView, new FrameLayout.LayoutParams(-1, -1));
        mediaFrame.addView(videoView, new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER));
        mediaFrame.addView(emptyView, new FrameLayout.LayoutParams(-1, -1));
        mediaFrame.setOnClickListener(v -> playSound());
        mainCol.addView(mediaFrame, new LinearLayout.LayoutParams(-1, 0, 1f));

        // 留言区（大字）
        senderView = text("", 20, SUBTLE);
        senderView.setBackgroundColor(0xFF182521);
        senderView.setPadding(dp(24), dp(10), dp(24), 0);
        mainCol.addView(senderView, new LinearLayout.LayoutParams(-1, -2));
        messageView = text("", 28, TEXT);
        messageView.setBackgroundColor(0xFF182521);
        messageView.setPadding(dp(24), dp(6), dp(24), dp(10));
        messageView.setEllipsize(null);
        mainCol.addView(messageView, new LinearLayout.LayoutParams(-1, -2));

        // 三大按钮
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(dp(12), dp(6), dp(12), dp(12));
        Button prev = bigButton("上一张", BUTTON, v -> navigate(1));
        playBtn = bigButton("播放", ACCENT, v -> playSound());
        Button next = bigButton("下一张", BUTTON, v -> navigate(-1));
        row.addView(prev, new LinearLayout.LayoutParams(0, -2, 1f));
        row.addView(playBtn, new LinearLayout.LayoutParams(0, -2, 1.2f));
        row.addView(next, new LinearLayout.LayoutParams(0, -2, 1f));
        mainCol.addView(row, new LinearLayout.LayoutParams(-1, -2));

        // 家人设置入口（角落极小）
        TextView settings = text("设置", 14, 0x66FFFFFF);
        settings.setPadding(dp(16), dp(10), dp(16), dp(10));
        settings.setBackgroundColor(0x22000000);
        outer.addView(settings, new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.END));
        settings.setOnClickListener(v -> startActivity(new Intent(this, ConfigActivity.class)));

        setContentView(outer);
    }

    // ---------------- 帖子列表与展示 ----------------

    /** 重新读取本地库；keepCurrent=true 时尽量不打断当前展示 */
    private void reloadPosts(boolean keepCurrent) {
        List<FrameStore.Post> fresh = store.postsSnapshot();
        String currentId = shownPostId;
        posts = fresh;
        if (posts.isEmpty()) {
            index = -1;
            shownPostId = null;
            showEmpty();
            return;
        }
        int at = currentId != null ? indexOf(currentId) : -1;
        if (at < 0) at = 0; // 无当前（或已被清理）：显示最新
        index = at;
        show(index, keepCurrent);
    }

    private int indexOf(String postId) {
        for (int i = 0; i < posts.size(); i++) {
            if (posts.get(i).id.equals(postId)) return i;
        }
        return -1;
    }

    private void showEmpty() {
        photoView.setImageDrawable(null);
        videoView.setVisibility(View.GONE);
        videoActive = false;
        emptyView.setVisibility(View.VISIBLE);
        senderView.setText(FrameConfig.configured(this) ? "" : "第一次使用请点右上角“设置”完成配对");
        messageView.setText("");
    }

    /** 展示第 index 个 post；keepCurrent=true 且没变化时仅刷新留言 */
    private void show(int i, boolean keepCurrent) {
        if (posts.isEmpty()) {
            showEmpty();
            return;
        }
        if (i < 0) i = 0;
        if (i >= posts.size()) i = posts.size() - 1;
        index = i;
        FrameStore.Post post = posts.get(i);
        boolean samePost = post.id.equals(shownPostId);
        shownPostId = post.id;

        // 留言区
        senderView.setText(post.memberName + " · " + friendlyDate(post.createdAt));
        messageView.setText(post.messageText == null ? "" : post.messageText);

        if (samePost && keepCurrent) {
            refreshCarouselTimer();
            return; // 不打断正在看的画面/正在播的媒体
        }

        stopPlayback();
        loading = true;

        List<FrameStore.Media> photos = new ArrayList<>();
        FrameStore.Media video = null;
        for (FrameStore.Media m : post.media) {
            if ("PHOTO".equals(m.type)) photos.add(m);
            else if (video == null && "VIDEO".equals(m.type)) video = m;
        }
        FrameStore.Media photo = photos.isEmpty() ? null : photos.get(Math.min(photoIndex, photos.size() - 1));
        if (photos.isEmpty()) photoIndex = 0;
        FrameStore.Media display = photo != null ? photo : video;

        if (display == null) {
            photoView.setImageDrawable(null);
            videoView.setVisibility(View.GONE);
            videoActive = false;
            emptyView.setVisibility(View.VISIBLE);
            emptyView.setText("这条只有声音，点击下方“播放”收听");
            loading = false;
            refreshCarouselTimer();
        } else if ("VIDEO".equals(display.type)) {
            emptyView.setVisibility(View.GONE);
            photoView.setImageDrawable(null);
            videoView.setVisibility(View.VISIBLE);
            videoActive = true;
            videoView.setVideoURI(Uri.fromFile(display.file(store.root())));
            videoView.setOnPreparedListener(mp -> {
                mp.setVolume(0f, 0f); // 到达新视频不自动发声
                mp.setLooping(false);
                mp.start();
                loading = false;
            });
            videoView.setOnCompletionListener(mp -> {
                // 播完定格在最后一帧，恢复轮播计时
                loading = false;
                refreshCarouselTimer();
            });
            videoView.setOnErrorListener((mp, what, extra) -> {
                loading = false;
                videoView.setVisibility(View.GONE);
                emptyView.setVisibility(View.VISIBLE);
                emptyView.setText("这段视频打不开");
                return true;
            });
        } else {
            emptyView.setVisibility(View.GONE);
            videoView.setVisibility(View.GONE);
            videoActive = false;
            showPhotoWithDissolve(display.file(store.root()));
            loading = false;
        }

        notifySeen(post.id);
        refreshCarouselTimer();
    }

    /** 保留上一张作为底层，让新照片在 400ms 内自然溶解进来。 */
    private void showPhotoWithDissolve(File file) {
        Drawable previous = photoView.getDrawable();
        photoView.setImageURI(Uri.fromFile(file));
        Drawable next = photoView.getDrawable();
        if (previous == null || next == null || !ValueAnimator.areAnimatorsEnabled()) return;
        TransitionDrawable dissolve = new TransitionDrawable(new Drawable[]{previous, next});
        dissolve.setCrossFadeEnabled(true);
        photoView.setImageDrawable(dissolve);
        dissolve.startTransition(400);
    }

    private String friendlyDate(long createdAt) {
        if (createdAt <= 0) return "";
        SimpleDateFormat day = new SimpleDateFormat("yyyyMMdd", Locale.CHINA);
        String today = day.format(new Date());
        String that = day.format(new Date(createdAt));
        if (today.equals(that)) return "今天";
        long diff = (System.currentTimeMillis() - createdAt) / 86400000L;
        if (diff < 2) return "昨天";
        return new SimpleDateFormat("M月d日", Locale.CHINA).format(new Date(createdAt));
    }

    // ---------------- 导航 ----------------

    /** dir=1 上一张（更旧），dir=-1 下一张（更新），与自动轮播同向（index+1 往旧）。 */
    private void navigate(int dir) {
        if (posts.isEmpty()) return;
        userActivity();
        stopPlayback();
        FrameStore.Post current = index >= 0 ? posts.get(index) : null;
        int photoCount = 0;
        if (current != null) {
            for (FrameStore.Media m : current.media) if ("PHOTO".equals(m.type)) photoCount++;
        }
        if (dir < 0 && photoIndex + 1 < photoCount) {
            photoIndex++;
            show(index, false);
            return;
        }
        if (dir > 0 && photoIndex > 0) {
            photoIndex--;
            show(index, false);
            return;
        }
        photoIndex = 0;
        int next = posts.size() == 0 ? 0 : ((index + dir) % posts.size() + posts.size()) % posts.size();
        show(next, false);
    }

    private void userActivity() {
        autoAdvance = false;
        lastActivityAt = System.currentTimeMillis();
    }

    // ---------------- 声音 ----------------

    private void playSound() {
        if (posts.isEmpty() || index < 0) return;
        final FrameStore.Post post = posts.get(index);
        userActivity();
        playBtn.setEnabled(false);

        FrameStore.Media voiceMedia = post.firstVoice();
        if (voiceMedia != null && voiceMedia.file(store.root()).exists()) {
            voice.playVoice(voiceMedia.file(store.root()), new VoiceEngine.Callback() {
                @Override public void onStart() { refreshCarouselTimer(); }
                @Override public void onFinish(boolean audible) {
                    main.post(() -> afterSound(post, audible));
                }
            });
            return;
        }
        String ttsText = VoiceEngine.buildTtsText(post.memberName, post.messageText);
        if (ttsText != null) {
            voice.speakText(ttsText, new VoiceEngine.Callback() {
                @Override public void onStart() { refreshCarouselTimer(); }
                @Override public void onFinish(boolean audible) {
                    main.post(() -> afterSound(post, audible));
                }
            });
            return;
        }
        // 无录音无留言：重放视频原声（视频 post 专用）
        if (videoActive) {
            videoView.setOnPreparedListener(mp -> {
                mp.setVolume(1f, 1f);
                mp.start();
            });
            videoView.seekTo(0);
            videoView.start();
            main.post(() -> afterSound(post, true));
            return;
        }
        main.post(() -> afterSound(post, false));
    }

    private void afterSound(FrameStore.Post post, boolean audible) {
        playBtn.setEnabled(true);
        if (audible && post != null) reportHeard(post.id);
        refreshCarouselTimer();
    }

    private void stopPlayback() {
        voice.stop();
        if (videoView.isPlaying()) {
            try {
                videoView.stopPlayback();
            } catch (Exception ignored) {
            }
        }
        playBtn.setEnabled(true);
    }

    // ---------------- 轮播（20 分钟） ----------------

    private final Runnable carouselTick = new Runnable() {
        @Override public void run() {
            if (posts.size() < 2 || voice.isPlaying() || loading) {
                refreshCarouselTimer();
                return;
            }
            autoAdvance = true;
            FrameStore.Post current = index >= 0 ? posts.get(index) : null;
            int photoCount = 0;
            if (current != null) {
                for (FrameStore.Media m : current.media) if ("PHOTO".equals(m.type)) photoCount++;
            }
            if (photoIndex + 1 < photoCount) {
                photoIndex++;
                show(index, false);
            } else {
                photoIndex = 0;
                show((index + 1) % posts.size(), false);
            }
            refreshCarouselTimer();
        }
    };

    private void refreshCarouselTimer() {
        main.removeCallbacks(carouselTick);
        if (posts.size() < 2 || voice.isPlaying() || loading) {
            // 播放/加载期间不换图：稍后再试计时
            if (voice.isPlaying() || loading) {
                main.postDelayed(this::refreshCarouselTimer, 5000);
            }
            return;
        }
        long now = System.currentTimeMillis();
        long idleAt = lastActivityAt > 0 ? lastActivityAt : now;
        long delay = autoAdvance ? CAROUSEL_INTERVAL_MS : Math.max(0, CAROUSEL_IDLE_MS - (now - idleAt));
        main.postDelayed(carouselTick, delay);
    }

    // ---------------- seen / heard ----------------

    private void notifySeen(String postId) {
        shownPostId = postId;
        FrameStore.Post p = store.postById(postId);
        if (p != null && p.seenReported) return;
        pendingSeen.add(postId);
        main.postDelayed(() -> {
            if (postId.equals(shownPostId) && pendingSeen.remove(postId)) {
                FrameStore.Post cur = store.postById(postId);
                if (cur != null && !cur.seenReported) {
                    markSeenLocal(postId);
                    io.execute(() -> {
                        SyncEngine engine = currentEngine();
                        if (engine != null && engine.postEvent(postId, "seen")) {
                            store.markSeen(postId);
                        }
                    });
                }
            }
        }, SEEN_AFTER_MS);
    }

    private void markSeenLocal(String postId) {
        // 先本地占位，防止重复上报（真正成功标记在事件成功后）
        FrameStore.Post p = store.postById(postId);
        if (p != null) store.markSeen(postId);
    }

    private void reportHeard(String postId) {
        FrameStore.Post p = store.postById(postId);
        if (p == null || p.heardReported) return;
        io.execute(() -> {
            SyncEngine engine = currentEngine();
            if (engine != null && engine.postEvent(postId, "heard")) {
                store.markHeard(postId);
            }
        });
    }

    private SyncEngine currentEngine() {
        String base = FrameConfig.baseUrl(this);
        String token = FrameConfig.token(this);
        if (!FrameConfig.configured(this)) return null;
        return new SyncEngine(store, base, token);
    }

    // ---------------- 同步 ----------------

    private void scheduleSync(long periodMs) {
        main.removeCallbacks(syncTick);
        main.postDelayed(syncTick, periodMs > 0 ? periodMs : 50);
    }

    private final Runnable syncTick = new Runnable() {
        @Override public void run() {
            syncNow("timer");
            main.postDelayed(this, SYNC_PERIOD_MS);
        }
    };

    private void syncNow(String reason) {
        if (!FrameConfig.configured(this)) return;
        io.execute(() -> {
            Set<String> protectedIds = new HashSet<>();
            String showing = shownPostId;
            if (showing != null) protectedIds.add(showing);
            SyncEngine engine = new SyncEngine(store, FrameConfig.baseUrl(this), FrameConfig.token(this));
            final SyncEngine.Result r = engine.sync(protectedIds, appVersion());
            main.post(() -> {
                if (r.ok && (r.newPosts > 0 || r.evictedPosts > 0)) {
                    reloadPosts(true); // 新内容入库；不打断当前展示，不自动发声
                }
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
}
