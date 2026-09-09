// SPDX-License-Identifier: GPL-3.0-or-later
package app.agbot.android;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/** Native-only transport. No WebView, arbitrary JS bridge, redirects, or trust-all TLS. */
public final class GatewayClient {
    private final URL base;
    private final String token;
    private final String pin;
    public GatewayClient(JSONObject config) throws Exception {
        base = new URL(config.optString("gatewayBase", "http://127.0.0.1:8765"));
        token = config.optString("bridgeToken", "").trim();
        pin = config.optString("certificateSha256", "").replace(":", "").replace(" ", "").toLowerCase(java.util.Locale.ROOT);
        if (base.getUserInfo() != null || base.getQuery() != null || base.getRef() != null ||
                (!base.getPath().isEmpty() && !base.getPath().equals("/"))) throw new IOException("Computer 地址只填写协议、主机和端口");
        if (!base.getProtocol().equals("https") && !(base.getProtocol().equals("http") && isLoopback(base.getHost())))
            throw new IOException("非 loopback 地址必须使用 HTTPS；不能通过明文网络发送密钥");
        if (!pin.isEmpty() && !pin.matches("[0-9a-f]{64}")) throw new IOException("证书指纹必须是 64 位 SHA-256");
        if (token.length() < 32 || token.contains("\r") || token.contains("\n")) throw new IOException("请先设置 Computer 配对令牌");
    }
    private static boolean isLoopback(String host) {
        return host.equals("127.0.0.1") || host.equals("localhost") || host.equals("::1") || host.equals("[::1]");
    }
    private static String fingerprint(X509Certificate certificate) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
        StringBuilder result = new StringBuilder();
        for (byte b : digest) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return result.toString();
    }
    private void configurePin(HttpsURLConnection connection) throws Exception {
        if (pin.isEmpty()) return; // Platform CA and hostname verification remain enabled.
        X509TrustManager manager = new X509TrustManager() {
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            public void checkClientTrusted(X509Certificate[] c, String a) throws CertificateException { throw new CertificateException("Client auth not supported"); }
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                try {
                    if (chain == null || chain.length == 0) throw new CertificateException("Missing certificate");
                    chain[0].checkValidity();
                    if (!pin.equals(fingerprint(chain[0]))) throw new CertificateException("Computer certificate fingerprint changed");
                } catch (CertificateException e) { throw e; } catch (Exception e) { throw new CertificateException(e); }
            }
        };
        SSLContext context = SSLContext.getInstance("TLS"); context.init(null, new TrustManager[]{manager}, new SecureRandom());
        connection.setSSLSocketFactory(context.getSocketFactory());
        // A user-paired exact certificate authenticates the guest, even if its private IP changes.
        connection.setHostnameVerifier((hostname, session) -> {
            try { return pin.equals(fingerprint((X509Certificate) session.getPeerCertificates()[0])); }
            catch (Exception e) { return false; }
        });
    }
    public JSONObject request(String method, String route, JSONObject body) throws Exception {
        if (!route.startsWith("/v1/") || route.contains("\r") || route.contains("\n")) throw new IOException("Invalid gateway route");
        HttpURLConnection connection = (HttpURLConnection) new URL(base, route).openConnection();
        try {
            if (connection instanceof HttpsURLConnection) configurePin((HttpsURLConnection) connection);
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(60000);
            connection.setRequestMethod(method); connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Accept", "application/json");
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            }
            int status = connection.getResponseCode();
            InputStream input = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            if (input == null) throw new IOException("Computer returned HTTP " + status);
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (InputStream in = input) {
                byte[] chunk = new byte[8192]; int count;
                while ((count = in.read(chunk)) != -1) {
                    if (output.size() + count > 8 * 1024 * 1024) throw new IOException("Computer response is too large");
                    output.write(chunk, 0, count);
                }
            }
            JSONObject value;
            try { value = new JSONObject(output.toString(StandardCharsets.UTF_8.name())); }
            catch (Exception e) { throw new IOException("Computer returned invalid JSON (HTTP " + status + ")"); }
            if (status < 200 || status >= 300) {
                JSONObject error = value.optJSONObject("error");
                throw new IOException(error != null ? error.optString("message", "HTTP " + status) : "HTTP " + status);
            }
            return value;
        } finally { connection.disconnect(); }
    }
}
