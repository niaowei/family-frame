/*
 * 离线中文语音合成封装（基于 eSpeakNG 1.52.0 原生库 libttsespeak.so）。
 * JNI 接口与开源项目 espeak-ng 保持一致（Apache License 2.0）。
 */

package com.reecedunn.espeak;

/**
 * 与原生 libttsespeak.so 对应的 JNI 封装。
 * 说明：
 * - nativeCreate 接收“包含 espeak-ng-data 目录的父目录”路径，返回采样率，0 表示失败；
 * - nativeSynthesize 为同步调用，PCM 数据通过 nativeSynthCallback(byte[]) 内联回调返回，
 *   收到 audioData == null 表示本次合成结束；
 * - 语音名使用 "cmn"（普通话）。
 */
public class SpeechSynthesis {
    static {
        System.loadLibrary("ttsespeak");
        nativeClassInit();
    }

    private final SynthReadyCallback mCallback;
    private boolean mInitialized = false;
    private int mSampleRate = 0;

    public SpeechSynthesis(String dataParentDir, SynthReadyCallback callback) {
        mCallback = callback;
        mSampleRate = nativeCreate(dataParentDir);
        mInitialized = mSampleRate != 0;
    }

    public boolean isInitialized() {
        return mInitialized;
    }

    public int getSampleRate() {
        return mSampleRate;
    }

    public boolean setVoiceByName(String name) {
        return nativeSetVoiceByName(name);
    }

    public boolean synthesize(String text, boolean isSsml) {
        return nativeSynthesize(text, isSsml);
    }

    public boolean stop() {
        return nativeStop();
    }

    /** 由 native 回调：交付一段 PCM(16bit 单声道)；audioData == null 表示合成结束。 */
    private void nativeSynthCallback(byte[] audioData) {
        if (mCallback == null) return;
        if (audioData == null) mCallback.onSynthDataComplete();
        else mCallback.onSynthDataReady(audioData);
    }

    @SuppressWarnings("unused")
    private void nativeSynthWordCallback(int textPosition, int textLength, int markerInFrames) {
        if (mCallback != null) mCallback.onSynthWordBoundary(textPosition, textLength, markerInFrames);
    }

    private static native boolean nativeClassInit();
    private native int nativeCreate(String path);
    private native boolean nativeSetVoiceByName(String name);
    private native boolean nativeSynthesize(String text, boolean isSsml);
    private native boolean nativeStop();

    public interface SynthReadyCallback {
        void onSynthDataReady(byte[] audioData);
        void onSynthDataComplete();
        void onSynthWordBoundary(int textPosition, int textLength, int markerInFrames);
    }
}
