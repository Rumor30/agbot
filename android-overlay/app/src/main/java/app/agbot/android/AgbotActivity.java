// SPDX-License-Identifier: GPL-3.0-or-later
package app.agbot.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** Original Agbot native UI; the DroidVM manager stays in the same APK as an advanced screen. */
public final class AgbotActivity extends Activity {
    private static final int BG = 0xff10151b, CARD = 0xff1b232d, INK = 0xffedf3f8, MUTED = 0xff9fafbf, ACCENT = 0xff70dfb5;
    private static final String[] MODES = {"codex", "responses", "chat-completions", "anthropic"};
    private static final String[] LABELS = {"Codex OAuth", "OpenAI Responses", "Chat Completions", "Anthropic Messages"};
    private static final int EXPORT_GUEST = 7001, IMPORT_PAIRING = 7002;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newFixedThreadPool(4);
    private final AtomicBoolean polling = new AtomicBoolean(false);
    private SecretStore secrets;
    private volatile JSONObject config = new JSONObject();
    private LinearLayout root, page, messages, approvalArea;
    private ScrollView chatScroll;
    private TextView status, streaming;
    private EditText composer;
    private Button send;
    private volatile String sessionId = "";
    private String tab = "chat", pendingSignature = "";
    private int viewGeneration = 0;
    private final AtomicBoolean submitting = new AtomicBoolean(false);
    private volatile long cursor = 0;
    private boolean resumed = false, destroyed = false, settingsReadable = true;
    private final Runnable pulse = new Runnable() {
        public void run() { if (!resumed || destroyed) return; if (tab.equals("chat") && !sessionId.isEmpty()) poll(); main.postDelayed(this, 1200); }
    };
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved); secrets = new SecretStore(this);
        String loadError = null;
        try { config = secrets.read(); sessionId = config.optString("sessionId", ""); }
        catch (Exception e) { settingsReadable = false; loadError = "无法解密已保存设置。没有覆盖原数据；请保留应用数据并检查 Keystore。"; }
        root = column(); root.setBackgroundColor(BG); root.setPadding(dp(16), dp(8), dp(16), dp(8)); setContentView(root);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
            view.setPadding(dp(16) + bars.left, dp(8) + bars.top, dp(16) + bars.right, dp(8) + bars.bottom); return insets;
        });
        LinearLayout heading = row(); TextView brand = text("Agbot", 27, INK); brand.setTypeface(null, Typeface.BOLD);
        heading.addView(brand, new LinearLayout.LayoutParams(0, dp(52), 1));
        Button fresh = button("新任务", this::newSession); heading.addView(fresh); root.addView(heading);
        status = text("云端模型 · 手机本地 Computer", 12, MUTED); root.addView(status);
        page = column(); root.addView(page, new LinearLayout.LayoutParams(-1, 0, 1));
        LinearLayout navigation = row();
        navigation.addView(button("聊天", () -> show("chat")), weighted());
        navigation.addView(button("会话", () -> show("sessions")), weighted());
        navigation.addView(button("Computer", () -> show("computer")), weighted());
        navigation.addView(button("设置", () -> show("settings")), weighted()); root.addView(navigation);
        show("chat"); if (loadError != null) error(loadError);
    }
    @Override protected void onResume() { super.onResume(); resumed = true; main.removeCallbacks(pulse); main.post(pulse); }
    @Override protected void onPause() { resumed = false; main.removeCallbacks(pulse); super.onPause(); }
    @Override protected void onDestroy() { destroyed = true; main.removeCallbacksAndMessages(null); io.shutdownNow(); super.onDestroy(); }
    private int dp(int n) { return Math.round(n * getResources().getDisplayMetrics().density); }
    private LinearLayout.LayoutParams weighted() { return new LinearLayout.LayoutParams(0, dp(52), 1); }
    private LinearLayout column() { LinearLayout v = new LinearLayout(this); v.setOrientation(LinearLayout.VERTICAL); return v; }
    private LinearLayout row() { LinearLayout v = new LinearLayout(this); v.setOrientation(LinearLayout.HORIZONTAL); v.setGravity(Gravity.CENTER_VERTICAL); return v; }
    private TextView text(String value, int size, int color) { TextView v = new TextView(this); v.setText(value); v.setTextSize(size); v.setTextColor(color); v.setPadding(0, dp(7), 0, dp(7)); return v; }
    private GradientDrawable background(int color) { GradientDrawable d = new GradientDrawable(); d.setColor(color); d.setCornerRadius(dp(14)); return d; }
    private Button button(String label, Runnable action) {
        Button b = new Button(this); b.setText(label); b.setTextColor(ACCENT); b.setTextSize(13); b.setAllCaps(false);
        b.setMinHeight(dp(48)); b.setBackgroundTintList(android.content.res.ColorStateList.valueOf(CARD));
        b.setOnClickListener(v -> action.run()); return b;
    }
    private EditText field(LinearLayout parent, String title, String value, boolean secret) {
        parent.addView(text(title, 13, MUTED)); EditText e = new EditText(this); e.setText(value); e.setTextColor(INK);
        e.setTextSize(15); e.setSingleLine(true); e.setSelectAllOnFocus(false);
        e.setInputType(InputType.TYPE_CLASS_TEXT | (secret ? InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS));
        e.setPadding(dp(12), dp(9), dp(12), dp(9)); e.setBackground(background(CARD)); parent.addView(e, new LinearLayout.LayoutParams(-1, dp(50))); return e;
    }
    private LinearLayout scrollingPage() { ScrollView scroll = new ScrollView(this); LinearLayout content = column(); scroll.addView(content); page.addView(scroll, new LinearLayout.LayoutParams(-1, -1)); return content; }
    private synchronized JSONObject snapshot() throws Exception { return new JSONObject(config.toString()); }
    private synchronized void put(String key, Object value) throws Exception {
        if (!settingsReadable) throw new Exception("旧设置解密失败，禁止覆盖");
        JSONObject next = new JSONObject(config.toString());
        if (value == null) next.remove(key); else next.put(key, value);
        secrets.write(next); config = next;
    }
    private void error(String message) { if (!destroyed) { status.setText(message); status.setTextColor(0xffffb8a9); } }
    private void healthy(String message) { if (!destroyed) { status.setText(message); status.setTextColor(ACCENT); } }
    private interface Work { JSONObject run() throws Exception; }
    private interface Result { void run(JSONObject value) throws Exception; }
    private void async(Work work, Result result) {
        io.execute(() -> {
            try { JSONObject value = work.run(); main.post(() -> { if (!destroyed) try { result.run(value); } catch (Exception e) { error(e.getMessage()); } }); }
            catch (Exception e) { main.post(() -> { if (!destroyed) { error(e.getMessage()); if (send != null) send.setEnabled(true); } }); }
        });
    }
    private JSONObject request(String method, String path, JSONObject body) throws Exception { return new GatewayClient(snapshot()).request(method, path, body); }
    private void show(String section) {
        viewGeneration++; tab = section; page.removeAllViews(); streaming = null;
        if (section.equals("chat")) showChat();
        else if (section.equals("settings")) showSettings();
        else if (section.equals("computer")) showComputer();
        else showSessions();
    }
    private void newSession() {
        if (submitting.get()) { error("消息提交中，请保留当前会话"); return; }
        try {
            if (!config.optString("outboxRequestId").isEmpty()) { error("上一条发送结果尚未确认，请回到聊天重试同一条消息。"); return; }
            sessionId = ""; cursor = 0; put("sessionId", ""); show("chat");
        } catch (Exception e) { error(e.getMessage()); }
    }
    private void showChat() {
        cursor = 0; pendingSignature = "";
        chatScroll = new ScrollView(this); messages = column(); chatScroll.addView(messages);
        page.addView(chatScroll, new LinearLayout.LayoutParams(-1, 0, 1));
        if (sessionId.isEmpty()) {
            messages.addView(text("让 AI 使用你的 Linux 电脑", 22, INK));
            messages.addView(text("用对话描述任务，查看执行过程，在写入或运行命令前确认。模型在云端，项目文件在手机虚拟机中。", 15, MUTED));
            messages.addView(button("配置模型与 Computer", () -> show("settings")));
        }
        approvalArea = column(); page.addView(approvalArea);
        composer = new EditText(this); composer.setTextColor(INK); composer.setHintTextColor(MUTED);
        composer.setHint("例如：检查这个项目为什么运行失败"); composer.setTextSize(15); composer.setMinLines(2); composer.setMaxLines(5);
        composer.setBackground(background(CARD)); composer.setPadding(dp(12), dp(10), dp(12), dp(10));
        composer.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        composer.setText(config.optString("outboxPrompt", "")); page.addView(composer, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout controls = row(); controls.addView(button("文件", () -> browseFiles(".")), weighted());
        controls.addView(button("停止", () -> {
            final String target = sessionId;
            if (!target.isEmpty()) async(() -> request("POST", "/v1/sessions/" + target + "/stop", new JSONObject()), v -> healthy("已请求停止，正在确认任务状态"));
        }), weighted());
        send = button("发送", this::submit); controls.addView(send, weighted()); page.addView(controls);
        if (!sessionId.isEmpty()) poll();
    }
    private void submit() {
        final String prompt = composer.getText().toString().trim(); if (prompt.isEmpty()) return;
        if (!settingsReadable) { error("无法读取加密设置，未发送"); return; }
        if (!submitting.compareAndSet(false, true)) return;
        final EditText originalComposer = composer;
        send.setEnabled(false);
        io.execute(() -> {
            try {
                JSONObject settings = snapshot();
                GatewayClient client = new GatewayClient(settings); // Freeze destination for the entire submission.
                String mode = settings.optString("mode", "codex");
                if (sessionId.isEmpty()) {
                    JSONObject s = client.request("POST", "/v1/sessions", new JSONObject()
                        .put("title", prompt.substring(0, Math.min(prompt.length(), 50))).put("mode", mode)
                        .put("model", settings.optString("model", "")).put("workspaceName", settings.optString("workspace", "default")));
                    sessionId = s.getString("id"); put("sessionId", sessionId); put("sessionMode", mode); cursor = 0;
                } else if (!settings.optString("sessionMode", mode).equals(mode)) throw new Exception("切换协议后请新建会话，避免历史记录格式混用");
                String pendingId = settings.optString("outboxRequestId", "");
                if (!pendingId.isEmpty() && !settings.optString("outboxPrompt").equals(prompt)) throw new Exception("请先重试上一条待确认消息；不能用新内容覆盖它");
                if (pendingId.isEmpty()) {
                    pendingId = UUID.randomUUID().toString();
                    synchronized (this) {
                        JSONObject next = snapshot(); next.put("outboxRequestId", pendingId); next.put("outboxPrompt", prompt);
                        secrets.write(next); config = next;
                    }
                }
                JSONObject profile = new JSONObject().put("mode", mode).put("model", settings.optString("model", ""))
                    .put("baseUrl", mode.equals("codex") ? "" : settings.optString("apiBase", ""))
                    .put("apiKey", mode.equals("codex") ? "" : settings.optString("apiKey", ""));
                client.request("POST", "/v1/sessions/" + sessionId + "/turns",
                    new JSONObject().put("prompt", prompt).put("profile", profile).put("requestId", pendingId));
                synchronized (this) {
                    JSONObject next = snapshot(); next.remove("outboxRequestId"); next.remove("outboxPrompt");
                    secrets.write(next); config = next;
                }
                main.post(() -> { if (!destroyed) { originalComposer.setText(""); healthy("任务已提交 · Linux 正在工作"); if (tab.equals("chat")) poll(); } });
            } catch (Exception e) { main.post(() -> { if (!destroyed) error(e.getMessage()); }); }
            finally { main.post(() -> { submitting.set(false); if (!destroyed && send != null) send.setEnabled(true); }); }
        });
    }
    private void poll() {
        if (sessionId.isEmpty() || !polling.compareAndSet(false, true)) return;
        final String target = sessionId; final long after = cursor; final int generation = viewGeneration;
        io.execute(() -> {
            try {
                JSONObject state = request("GET", "/v1/sessions/" + target + "?after=" + after, null);
                main.post(() -> { if (destroyed || generation != viewGeneration || !tab.equals("chat") || !sessionId.equals(target)) return;
                    try {
                        if (state.optBoolean("truncated")) { messages.removeAllViews(); streaming = null; }
                        JSONArray events = state.getJSONArray("events");
                        for (int i = 0; i < events.length(); i++) {
                            JSONObject event = events.getJSONObject(i);
                            if (event.getLong("id") > cursor) renderEvent(event);
                        }
                        cursor = Math.max(cursor, state.getLong("cursor")); renderApprovals(state.optJSONArray("pending"));
                        healthy("Computer 已连接 · " + state.getString("status") + " · " + state.optString("model", "Codex"));
                    } catch (Exception e) { error(e.getMessage()); }
                });
            } catch (Exception e) { main.post(() -> { if (!destroyed && tab.equals("chat")) error("连接中断；不代表 Linux 任务停止。" + e.getMessage()); }); }
            finally { polling.set(false); }
        });
    }
    private TextView bubble(String label, String content, boolean mono) {
        LinearLayout box = column(); box.setBackground(background(CARD)); box.setPadding(dp(12), dp(5), dp(12), dp(10));
        TextView title = text(label, 12, ACCENT); box.addView(title);
        TextView body = text(content, mono ? 12 : 15, INK); body.setTextIsSelectable(true);
        if (mono) { body.setTypeface(Typeface.MONOSPACE); body.setMaxLines(8); body.setOnClickListener(v -> body.setMaxLines(body.getMaxLines() == 8 ? 1000 : 8)); }
        box.addView(body); LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2); p.setMargins(0, dp(8), 0, dp(3)); messages.addView(box, p);
        while (messages.getChildCount() > 250) messages.removeViewAt(0);
        chatScroll.post(() -> chatScroll.fullScroll(View.FOCUS_DOWN)); return body;
    }
    private void renderEvent(JSONObject event) throws Exception {
        String type = event.getString("type"); JSONObject d = event.optJSONObject("data"); if (d == null) d = new JSONObject();
        switch (type) {
            case "user.message": streaming = null; bubble("你", d.optString("text"), false); break;
            case "model.request": streaming = null; break;
            case "text.delta":
                if (streaming == null) streaming = bubble("Agbot", "", false);
                streaming.append(d.optString("text")); break;
            case "assistant.message":
                if (streaming == null) bubble("Agbot", d.optString("text"), false); else streaming.setText(d.optString("text"));
                streaming = null; break;
            case "tool.started": bubble("执行 · " + d.optString("name"), d.optJSONObject("arguments") == null ? "" : d.getJSONObject("arguments").toString(2), true); break;
            case "tool.output": bubble("命令输出", d.optString("text"), true); break;
            case "tool.completed": bubble("完成 · " + d.optString("name"), d.optJSONObject("result") == null ? "" : d.getJSONObject("result").toString(2), true); break;
            case "tool.failed": case "task.failed": case "task.cancelled": bubble("任务状态", d.optString("error"), false); break;
            case "tool.denied": bubble("已拒绝", d.optString("name"), false); break;
            case "interrupted": bubble("任务已中断", "没有自动重放命令。继续前请检查文件实际状态。", false); break;
            case "task.completed": bubble("已完成", "本轮任务结束。", false); break;
            case "codex.item": bubble("Codex · " + d.optString("state"), d.toString(2), true); break;
            default: break;
        }
    }
    private void renderApprovals(JSONArray pending) throws Exception {
        if (pending == null) pending = new JSONArray(); String signature = pending.toString();
        if (signature.equals(pendingSignature)) return; pendingSignature = signature; approvalArea.removeAllViews();
        for (int i = 0; i < pending.length(); i++) {
            JSONObject item = pending.getJSONObject(i), details = item.getJSONObject("details"); final String approvalId = item.getString("id");
            LinearLayout card = column(); card.setPadding(dp(8), dp(4), dp(8), dp(4)); card.setBackground(background(CARD));
            card.addView(text("需要确认 · " + details.optString("name", "Codex 操作"), 15, ACCENT));
            final String preview = details.toString(2);
            card.addView(button("查看命令 / 修改前后内容", () -> showText("待批准的操作", preview)));
            LinearLayout buttons = row();
            buttons.addView(button("拒绝", () -> decide(approvalId, false)), weighted());
            buttons.addView(button("仅允许这一次", () -> decide(approvalId, true)), weighted()); card.addView(buttons); approvalArea.addView(card);
        }
    }
    private void decide(String id, boolean allow) {
        final String target = sessionId;
        async(() -> request("POST", "/v1/sessions/" + target + "/approvals/" + id, new JSONObject().put("allow", allow)), result -> poll());
    }
    private void showSessions() {
        LinearLayout content = scrollingPage(); content.addView(text("任务与会话", 22, INK));
        async(() -> request("GET", "/v1/sessions", null), value -> {
            if (!tab.equals("sessions")) return; JSONArray sessions = value.getJSONArray("sessions");
            if (sessions.length() == 0) content.addView(text("还没有会话。新建一个任务开始。", 15, MUTED));
            for (int i = 0; i < sessions.length(); i++) {
                JSONObject item = sessions.getJSONObject(i);
                content.addView(button(item.optString("title") + "\n" + item.optString("mode") + " · " + item.optString("status"), () -> {
                    try {
                        if (submitting.get() || !config.optString("outboxRequestId").isEmpty()) { error("先确认上一条待发送消息的结果"); return; }
                        sessionId = item.getString("id"); put("sessionId", sessionId); put("sessionMode", item.getString("mode")); show("chat");
                    } catch (Exception e) { error(e.getMessage()); }
                }));
            }
        });
    }
    private void showComputer() {
        LinearLayout content = scrollingPage(); content.addView(text("本地 Linux Computer", 22, INK));
        content.addView(text("Gunyah 节点：" + (new File("/dev/gunyah").exists() ? "可见" : "当前应用不可见 / 不存在")
                + "\nAndroid " + android.os.Build.VERSION.RELEASE + " · " + android.os.Build.MODEL, 15, INK));
        content.addView(text("设备节点存在不等于已经通过虚拟机启动测试。Agbot 内含修改后的 DroidVM，不调用手机里另一个 DroidVM 安装实例。", 14, MUTED));
        content.addView(button("打开内置虚拟机管理 / 首次配置", () -> {
            Intent intent = new Intent(); intent.setClassName(getPackageName(), "cn.classfun.droidvm.ui.SplashActivity");
            try { startActivity(intent); } catch (Exception e) { error("内置 DroidVM 入口不可用：" + e.getMessage()); }
        }));
        content.addView(button("检查 Guest 连接", () -> async(() -> request("GET", "/v1/health", null), value -> showText("真实连接结果", value.toString(2)))));
        content.addView(button("导出 Guest 安装包", () -> {
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT); intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("application/gzip"); intent.putExtra(Intent.EXTRA_TITLE, "agbot-guest.tar.gz"); startActivityForResult(intent, EXPORT_GUEST);
        }));
        content.addView(text("开发版边界：Linux 镜像与 Guest 服务目前需要一次性初始化。全自动下载、预置镜像和自动配对尚未完成，不能把网关健康状态当作完整真机验收。", 14, MUTED));
        content.addView(button("导入 Computer 配对文件", () -> {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT); intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("application/json"); startActivityForResult(intent, IMPORT_PAIRING);
        }));
        content.addView(button("设置连接地址与证书指纹", () -> show("settings")));
    }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri target = data.getData();
        if (requestCode == IMPORT_PAIRING) {
            async(() -> {
                try (InputStream in = getContentResolver().openInputStream(target)) {
                    if (in == null) throw new Exception("无法读取配对文件");
                    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                    byte[] buffer = new byte[1024]; int n;
                    while ((n = in.read(buffer)) != -1) {
                        if (out.size() + n > 8192) throw new Exception("配对文件过大"); out.write(buffer, 0, n);
                    }
                    JSONObject pairing = new JSONObject(out.toString("UTF-8"));
                    if (pairing.optInt("schema") != 1) throw new Exception("不支持的配对文件版本");
                    new GatewayClient(pairing); // Validate URL, token and exact certificate fingerprint.
                    return pairing;
                }
            }, pairing -> new AlertDialog.Builder(this).setTitle("连接这台 Computer？")
                .setMessage("仅导入你自己 Guest 导出的文件。确认地址：\n" + pairing.getString("gatewayBase")
                    + "\n证书 SHA-256：\n" + pairing.optString("certificateSha256")
                    + "\n导入后请删除中转的配对文件；其中含有私密令牌。")
                .setPositiveButton("确认配对", (dialog, which) -> {
                    try {
                        if (!settingsReadable || submitting.get()) throw new Exception("当前不能替换连接设置");
                        if (!config.optString("outboxRequestId").isEmpty()) throw new Exception("先确认待发送消息的结果，再更换 Computer");
                        synchronized (this) {
                            JSONObject next = snapshot();
                            next.put("gatewayBase", pairing.getString("gatewayBase")); next.put("bridgeToken", pairing.getString("bridgeToken"));
                            next.put("certificateSha256", pairing.optString("certificateSha256")); next.remove("sessionId"); next.remove("sessionMode");
                            secrets.write(next); config = next; sessionId = ""; cursor = 0;
                        }
                        healthy("Computer 已配对，下一步检查连接");
                    } catch (Exception e) { error(e.getMessage()); }
                }).setNegativeButton("取消", null).show());
            return;
        }
        if (requestCode != EXPORT_GUEST) return;
        async(() -> {
            try (InputStream in = getAssets().open("agbot/agbot-guest.tgz"); OutputStream out = getContentResolver().openOutputStream(target)) {
                if (out == null) throw new Exception("无法打开目标文件"); byte[] b = new byte[8192]; int n;
                while ((n = in.read(b)) != -1) out.write(b, 0, n);
            }
            return new JSONObject();
        }, result -> healthy("Guest 安装包已导出；不含模型密钥或登录凭据"));
    }
    private void showSettings() {
        LinearLayout content = scrollingPage(); content.addView(text("模型与连接", 22, INK));
        content.addView(text("API Key 与 Computer 配对令牌使用 Android Keystore 加密。Codex 登录凭据由 Linux Guest 内的官方 CLI 管理。", 13, MUTED));
        Spinner protocols = new Spinner(this);
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, LABELS); protocols.setAdapter(adapter);
        protocols.setSelection(Math.max(0, Arrays.asList(MODES).indexOf(config.optString("mode", "codex")))); content.addView(protocols);
        EditText model = field(content, "模型 ID（Codex 可留空使用账户默认模型）", config.optString("model"), false);
        EditText api = field(content, "API Base URL（Codex 不使用此字段）", config.optString("apiBase"), false);
        EditText key = field(content, "API Key（Codex OAuth 不需要）", config.optString("apiKey"), true);
        EditText workspace = field(content, "工作区名称", config.optString("workspace", "default"), false);
        EditText gateway = field(content, "Computer 地址", config.optString("gatewayBase", "http://127.0.0.1:8765"), false);
        EditText token = field(content, "Computer 配对令牌", config.optString("bridgeToken"), true);
        EditText pin = field(content, "Guest 证书 SHA-256（自签 HTTPS 必填）", config.optString("certificateSha256"), false);
        content.addView(button("保存加密设置", () -> {
            try {
                if (submitting.get()) throw new Exception("正在提交消息，暂不切换连接配置");
                if (!config.optString("outboxRequestId").isEmpty()) throw new Exception("上一条消息结果未确认，先回到聊天重试，再修改配置");
                JSONObject previous = snapshot();
                JSONObject next = snapshot(); next.put("mode", MODES[protocols.getSelectedItemPosition()]); next.put("model", model.getText().toString().trim());
                next.put("apiBase", api.getText().toString().trim()); next.put("apiKey", key.getText().toString().trim());
                next.put("workspace", workspace.getText().toString().trim()); next.put("gatewayBase", gateway.getText().toString().trim());
                next.put("bridgeToken", token.getText().toString().trim()); next.put("certificateSha256", pin.getText().toString().trim());
                if (!settingsReadable) throw new Exception("旧设置解密失败，禁止覆盖");
                boolean destinationChanged = !previous.optString("gatewayBase").equals(next.optString("gatewayBase"))
                    || !previous.optString("bridgeToken").equals(next.optString("bridgeToken"))
                    || !previous.optString("certificateSha256").equals(next.optString("certificateSha256"));
                if (destinationChanged) { next.put("sessionId", ""); next.remove("sessionMode"); }
                secrets.write(next); synchronized (this) { config = next; }
                if (destinationChanged) { sessionId = ""; cursor = 0; }
                healthy("设置已加密保存");
            } catch (Exception e) { error(e.getMessage()); }
        }));
        content.addView(button("使用 ChatGPT 账户登录 Codex", () -> async(() -> request("POST", "/v1/codex/login", new JSONObject()), value -> {
            String url = value.getString("verificationUrl"), code = value.getString("userCode"); Uri uri = Uri.parse(url);
            if (!"https".equals(uri.getScheme()) || !Arrays.asList("auth.openai.com", "chatgpt.com").contains(uri.getHost()))
                throw new Exception("拒绝打开未知的登录域名");
            new AlertDialog.Builder(this).setTitle("Codex 设备授权").setMessage("验证码：" + code + "\n\n在官方页面完成登录；密码不会交给 Agbot。返回后检查登录状态。")
                .setPositiveButton("复制验证码并打开", (dialog, which) -> {
                    ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    clipboard.setPrimaryClip(ClipData.newPlainText("Codex device code", code)); startActivity(new Intent(Intent.ACTION_VIEW, uri));
                }).setNegativeButton("关闭", null).show();
        })));
        content.addView(button("检查 Codex 登录", () -> async(() -> request("GET", "/v1/codex/account", null), value -> showText("Codex 账户", value.toString(2)))));
        content.addView(button("读取 Codex 可用模型", () -> async(() -> request("GET", "/v1/codex/models", null), value -> showText("账户返回的模型列表", value.toString(2)))));
        content.addView(button("退出 Codex 登录", () -> new AlertDialog.Builder(this).setTitle("退出登录？")
            .setMessage("会清除这台 Linux Guest 中 Codex 管理的登录状态。")
            .setPositiveButton("退出", (d, w) -> async(() -> request("POST", "/v1/codex/logout", new JSONObject()), value -> healthy("Codex 已退出")))
            .setNegativeButton("取消", null).show()));
    }
    private void browseFiles(String relative) {
        if (sessionId.isEmpty()) { error("请先选择一个会话"); return; }
        final String id = sessionId;
        async(() -> request("GET", "/v1/sessions/" + id + "/files?path=" + URLEncoder.encode(relative, StandardCharsets.UTF_8.name()), null), value -> {
            JSONArray entries = value.getJSONArray("entries"); ArrayList<String> labels = new ArrayList<>(); labels.add(".. 返回上级");
            for (int i = 0; i < entries.length(); i++) { JSONObject e = entries.getJSONObject(i); labels.add((e.getString("type").equals("directory") ? "[目录] " : "") + e.getString("name")); }
            new AlertDialog.Builder(this).setTitle(relative).setItems(labels.toArray(new String[0]), (dialog, which) -> {
                if (which == 0) { int slash = relative.lastIndexOf('/'); browseFiles(slash < 0 ? "." : relative.substring(0, slash)); return; }
                try {
                    JSONObject item = entries.getJSONObject(which - 1); String p = relative.equals(".") ? item.getString("name") : relative + "/" + item.getString("name");
                    if (item.getString("type").equals("directory")) browseFiles(p);
                    else if (item.getString("type").equals("symlink")) error("文件工具不跟随符号链接");
                    else async(() -> request("GET", "/v1/sessions/" + id + "/files?read=1&path=" + URLEncoder.encode(p, StandardCharsets.UTF_8.name()), null), v -> showText(p, v.getString("content")));
                } catch (Exception e) { error(e.getMessage()); }
            }).setNegativeButton("关闭", null).show();
        });
    }
    private void showText(String title, String value) {
        ScrollView scroll = new ScrollView(this); TextView body = text(value, 13, INK); body.setBackgroundColor(CARD); body.setPadding(dp(16), dp(12), dp(16), dp(12));
        body.setTextIsSelectable(true); body.setTypeface(Typeface.MONOSPACE); scroll.addView(body);
        new AlertDialog.Builder(this).setTitle(title).setView(scroll).setPositiveButton("关闭", null).show();
    }
}
