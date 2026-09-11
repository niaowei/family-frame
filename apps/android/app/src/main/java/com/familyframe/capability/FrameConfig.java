/*
 * 相框配置（SharedPreferences）：服务器地址 + 设备令牌。
 * 令牌只存在本机应用私有存储，不写入媒体库（备份导出不含它）。
 */

package com.familyframe.capability;

import android.content.Context;
import android.content.SharedPreferences;

public class FrameConfig {
    private static final String PREFS = "frame_config";
    private static final String KEY_BASE = "baseUrl";
    private static final String KEY_TOKEN = "deviceToken";

    public static String baseUrl(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String v = sp.getString(KEY_BASE, "").trim();
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        return v;
    }

    public static String token(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return sp.getString(KEY_TOKEN, "").trim();
    }

    public static boolean configured(Context ctx) {
        return baseUrl(ctx).startsWith("http") && token(ctx).length() >= 16;
    }

    public static boolean save(Context ctx, String baseUrl, String token) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return sp.edit().putString(KEY_BASE, baseUrl == null ? "" : baseUrl.trim())
                .putString(KEY_TOKEN, token == null ? "" : token.trim())
                .commit();
    }

    /** 兼容 http://（内网测试）与 https://（正式）。显示用摘要：不回显完整令牌 */
    public static String describe(Context ctx) {
        String b = baseUrl(ctx);
        String t = token(ctx);
        if (b.isEmpty()) return "未配置";
        String masked = t.length() >= 8 ? t.substring(0, 4) + "…" + t.substring(t.length() - 4) : "未配置";
        return b + "｜令牌 " + masked;
    }
}
