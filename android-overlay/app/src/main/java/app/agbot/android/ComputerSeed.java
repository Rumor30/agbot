// SPDX-License-Identifier: GPL-3.0-or-later
package app.agbot.android;
import android.content.Context;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;

/** Builds a read-only guest seed; no account credentials or endpoint key are included. */
public final class ComputerSeed {
    private ComputerSeed() {}
    public static byte[] asset(Context c,String path) throws IOException {
        try(InputStream in=c.getAssets().open(path);ByteArrayOutputStream out=new ByteArrayOutputStream()){
            byte[] b=new byte[16384];int n;while((n=in.read(b))!=-1){if(out.size()+n>8*1024*1024)throw new IOException("Asset too large");out.write(b,0,n);}return out.toByteArray();
        }
    }
    public static String sha(byte[] data) throws Exception {
        StringBuilder s=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(data))s.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return s.toString();
    }
    public static void write(Context c,File destination,JSONObject identity) throws Exception {
        byte[] payload=asset(c,"agbot/agbot-guest.tgz");
        byte[] bootstrap=asset(c,"agbot/seed_bootstrap.py");
        String unit="[Unit]\nDescription=Agbot dedicated Computer provisioning\nAfter=network-online.target cloud-final.service\nWants=network-online.target\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 /usr/local/sbin/agbot-seed-bootstrap.py\nRestart=on-failure\nRestartSec=30\nTimeoutStartSec=25min\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n";
        JSONArray writes=new JSONArray().put(new JSONObject().put("path","/usr/local/sbin/agbot-seed-bootstrap.py").put("permissions","0700").put("encoding","b64").put("content",Base64.encodeToString(bootstrap,Base64.NO_WRAP)))
            .put(new JSONObject().put("path","/etc/systemd/system/agbot-bootstrap.service").put("permissions","0644").put("content",unit));
        JSONObject cloud=new JSONObject().put("ssh_pwauth",false).put("disable_root",true).put("write_files",writes)
            .put("runcmd",new JSONArray().put(new JSONArray().put("systemctl").put("daemon-reload"))
            .put(new JSONArray().put("systemctl").put("enable").put("agbot-bootstrap.service"))
            .put(new JSONArray().put("systemctl").put("start").put("--no-block").put("agbot-bootstrap.service")));
        LinkedHashMap<String,byte[]> files=new LinkedHashMap<>();
        files.put("user-data",("#cloud-config\n"+cloud+"\n").getBytes(StandardCharsets.UTF_8));
        files.put("meta-data",new JSONObject().put("instance-id",identity.getString("id")).put("local-hostname","agbot-computer").toString().getBytes(StandardCharsets.UTF_8));
        JSONObject nic=new JSONObject().put("match",new JSONObject().put("macaddress",identity.getString("mac"))).put("dhcp4",true).put("dhcp6",false);
        files.put("network-config",new JSONObject().put("version",2).put("ethernets",new JSONObject().put("agbot0",nic)).toString().getBytes(StandardCharsets.UTF_8));
        files.put("payload.tgz",payload);
        files.put("agbot.json",new JSONObject().put("schema",1).put("instanceId",identity.getString("id")).put("bridgeToken",identity.getString("token")).put("payloadSha256",sha(payload)).toString().getBytes(StandardCharsets.UTF_8));
        SeedDisk.write(destination,files);
    }
}
