// SPDX-License-Identifier: GPL-3.0-or-later
package app.agbot.android;

import android.content.Context;
import android.os.Build;
import android.os.StatFs;
import android.util.Base64;
import com.topjohnwu.superuser.Shell;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;
import java.util.*;
import cn.classfun.droidvm.lib.daemon.DaemonClient;
import cn.classfun.droidvm.lib.daemon.DaemonHelper;
import cn.classfun.droidvm.lib.ui.UIContext;
import cn.classfun.droidvm.lib.utils.AssetUtils;
import cn.classfun.droidvm.lib.store.vm.*;
import cn.classfun.droidvm.lib.store.network.*;
import cn.classfun.droidvm.lib.network.IPv4Network;
import cn.classfun.droidvm.lib.network.IPv6Network;
import cn.classfun.droidvm.ui.network.NetworkPresets;

/** Owns one explicitly-created private Computer. Never accepts a model-generated host command. */
public final class LocalComputer implements AutoCloseable {
    public interface Progress { void set(String stage,String message) throws Exception; }
    private final Context context; private final SecretStore secrets; private final Progress progress;
    private DaemonClient daemon; private JSONObject identity; private String phase="ROOT";

    public LocalComputer(Context c,Progress p){context=c.getApplicationContext();secrets=new SecretStore(context);progress=p;}
    private void stage(String code,String message) throws Exception {check();phase=code;progress.set(code,message);}
    private static void check() throws InterruptedException {if(Thread.currentThread().isInterrupted())throw new InterruptedException("准备已取消，磁盘数据保留");}
    private static String q(String value){return "'"+value.replace("'","'\\''")+"'";}

    private String shell(String cmd) throws Exception {
        check();
        Shell.Result r=Shell.cmd(cmd).exec();
        if(!r.isSuccess())throw new IOException(phase+"：宿主操作失败 (exit "+r.getCode()+") "+String.join(" ",r.getErr()));
        return String.join("\n",r.getOut());
    }

    private void root() throws Exception {
        stage("ROOT","正在申请 Root；只用于本地虚拟机管理");
        if(!Shell.getShell().isRoot())throw new IOException("需要授予 Agbot Root；不支持无 Root 本地 Computer");
        if(!Arrays.asList(Build.SUPPORTED_ABIS).contains("arm64-v8a"))throw new IOException("本地 VM 运行时要求 ARM64；模拟器仅支持界面测试");
        shell("test -c /dev/gunyah");
        stage("ROOT_OK","Root 与 Gunyah 节点已确认；尚不代表 Guest 已启动");
    }

    private File directory() throws Exception {
        File base=new File(context.getFilesDir(),"computer");
        if(!base.isDirectory() && !base.mkdirs())throw new IOException("不能创建 Computer 私有目录");
        identity=secrets.read().optJSONObject("computerIdentity");
        if(identity==null){
            byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);String id=UUID.randomUUID().toString();
            int port;try(ServerSocket s=new ServerSocket(0,1,InetAddress.getByName("127.0.0.1"))){port=s.getLocalPort();}
            identity=new JSONObject().put("id",id).put("networkId",UUID.randomUUID().toString()).put("hostPort",port)
                .put("mac","02:"+id.substring(0,2)+":"+id.substring(2,4)+":"+id.substring(4,6)+":"+id.substring(6,8)+":01")
                .put("token",Base64.encodeToString(bytes,Base64.NO_WRAP|Base64.URL_SAFE|Base64.NO_PADDING));
            secrets.update(new JSONObject().put("computerIdentity",identity));
        }
        UUID.fromString(identity.getString("id"));UUID.fromString(identity.getString("networkId"));
        if(identity.getInt("hostPort")<1024 || identity.getInt("hostPort")>65535 || !identity.getString("token").matches("[A-Za-z0-9_-]{43}"))
            throw new IOException("Computer 身份损坏；保留数据并停止");
        File dir=new File(base,identity.getString("id"));
        if(!dir.isDirectory()&&!dir.mkdir())throw new IOException("Cannot create private instance");
        return dir;
    }

    private void connectDaemon() throws Exception {
        stage("DAEMON","连接内置 DroidVM 管理进程");
        if(!DaemonHelper.isDaemonRunning()){
            DaemonHelper helper=new DaemonHelper(new UIContext(){public boolean isAlive(){return true;}public Context getContext(){return context;}});
            if(!helper.startDaemon())throw new IOException("DroidVM daemon 启动失败；未强制重启其他 VM");
        }
        Exception last=null;
        for(int i=0;i<30;i++){
            check();
            try{
                int port=DaemonHelper.readPort();String token=DaemonHelper.readToken();
                if(port<=0||token==null)throw new IOException("daemon 尚未就绪");
                daemon=new DaemonClient();daemon.connect(port);rpc("auth",new JSONObject().put("token",token));return;
            }catch(Exception e){last=e;if(daemon!=null)daemon.close();Thread.sleep(500);}
        }
        throw new IOException("无法认证 DroidVM daemon",last);
    }

    private JSONObject rpc(String command,JSONObject body) throws Exception {
        check();
        JSONObject request=new JSONObject(body.toString()).put("command",command);
        JSONObject result=daemon.request(request);
        if(!result.optBoolean("success"))throw new IOException(command+"："+result.optString("message","操作失败"));
        return result;
    }
    private JSONObject vmArgs() throws Exception{return new JSONObject().put("vm_id",identity.getString("id"));}
    private JSONObject netArgs() throws Exception{return new JSONObject().put("network_id",identity.getString("networkId"));}

    private String console() throws Exception {
        JSONObject history=rpc("vm_console_history",vmArgs());StringBuilder text=new StringBuilder();
        for(String key:Arrays.asList("serial1","sbsa1","vcon1","stdio","stdout","stderr")){
            String encoded=history.optString(key,"");
            if(!encoded.isEmpty())text.append(key).append(":\n").append(URLDecoder.decode(encoded,"UTF-8")).append('\n');
        }
        return text.toString();
    }

    private void diagnostics(File dir,String output){
        try{
            String sanitized=output.replace(identity.getString("token"),"[REDACTED]")
                .replaceAll("(?i)(Bearer\\s+|sk-)[A-Za-z0-9._-]+","[REDACTED]");
            if(sanitized.length()>200000)sanitized=sanitized.substring(sanitized.length()-200000);
            Files.writeString(new File(dir,"console.log").toPath(),sanitized,StandardCharsets.UTF_8);
        }catch(Exception ignored){}
    }

    public void start() throws Exception {
        root();
        File dir=directory(),disk=new File(dir,"root.qcow2"),seed=new File(dir,"seed.img");
        stage("RUNTIME","准备 APK 内固定版本虚拟化运行时");
        if(!DaemonHelper.isDaemonRunning()){
            AssetUtils.extractBinaries(context);AssetUtils.extractLibraries(context);AssetUtils.extractPrebuilt(context);
        }else if(AssetUtils.needsExtractPrebuilt(context)){
            throw new IOException("运行时需要更新，但 daemon 正在运行；请在高级管理器停止 VM/daemon 后重试");
        }
        connectDaemon();
        boolean exists=rpc("vm_exists",vmArgs()).optBoolean("exists");
        String existingState=exists?rpc("vm_status",vmArgs()).optString("state"):"stopped";
        if(existingState.equals("running")||existingState.equals("starting")){
            stage("RECONNECT","Computer 已启动，正在重连");awaitGuest(dir);return;
        }
        if(existingState.equals("suspended"))throw new IOException("Computer 已挂起，请先在高级管理器恢复或关机");

        if(!disk.exists()){
            if(new StatFs(dir.getPath()).getAvailableBytes()<3L*1024*1024*1024)
                throw new IOException("至少需要 3 GiB 空闲空间以创建 Linux；后续项目另需空间");
            stage("DOWNLOAD","下载固定 Ubuntu 24.04 ARM64 镜像（约 218 MiB，可断点续传）");
            File source=new File(dir,"ubuntu-source.img");
            JSONObject images=new JSONObject(new String(ComputerSeed.asset(context,"agbot/images.lock.json"),StandardCharsets.UTF_8));
            JSONObject image=images.getJSONObject("arm64");
            ComputerDownload.fetch(images.getString("baseUrl")+image.getString("file"),image.getString("sha256"),source,
                n->stage("DOWNLOAD","已下载 "+(n/1048576)+" MiB；完成后校验 SHA-256"));
            stage("DISK","镜像校验通过，创建 24 GiB 稀疏工作磁盘；不会清理已有项目");
            File staging=new File(dir,"root."+UUID.randomUUID()+".qcow2.building");
            String data=context.getApplicationInfo().dataDir;
            String tool="/system/bin/toybox timeout -s KILL 300 env LD_LIBRARY_PATH="+q(data+"/usr/lib:"+data+"/lib")+" "+q(data+"/usr/bin/qemu-img");
            shell(tool+" convert -f qcow2 -O qcow2 "+q(source.getPath())+" "+q(staging.getPath()));
            shell(tool+" resize "+q(staging.getPath())+" 24G");
            shell("chown "+android.os.Process.myUid()+":"+android.os.Process.myUid()+" "+q(staging.getPath())+" && chmod 600 "+q(staging.getPath()));
            if(disk.exists())throw new IOException("工作磁盘已出现，拒绝替换；转换副本保留");
            Files.move(staging.toPath(),disk.toPath(),StandardCopyOption.ATOMIC_MOVE);
        }

        stage("SEED","准备只读 Linux 自动初始化磁盘");
        File stagingSeed=new File(dir,"seed."+UUID.randomUUID()+".img.building");
        ComputerSeed.write(context,stagingSeed,identity);
        Files.move(stagingSeed.toPath(),seed.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);

        stage("VM_CONFIG","应用 Gunyah headless 兼容配置；已有磁盘原地保留");
        register(dir,disk,seed,exists);
        stage("NETWORK","启动专用 NAT 网络；Guest 接口仅转发到手机 loopback");
        if(!rpc("network_status",netArgs()).optString("state").equals("running"))rpc("network_start",netArgs());
        stage("BOOT","通过 Gunyah 启动 Linux；正在等待系统与 Guest 服务");
        rpc("vm_start",vmArgs().put("clear_logs_before_start",true));
        awaitGuest(dir);
    }

    /**
     * Agbot is a headless Linux workstation and does not need host direct access to guest RAM.
     * DroidVM's generic new-VM default is PSEUDO_UNPROTECTED; that path requires the optional
     * gunyah_host_share module and /dev/gunyah_share. Some stock 6.6 SM8750 kernels expose
     * /dev/gunyah but do not ship/load that helper, which makes crosvm fail during VM init with
     * ENOENT. Use the native Gunyah protected-without-firmware path explicitly instead of
     * inheriting a GUI-oriented default. Existing Agbot-owned VMs are migrated in place.
     */
    private void applyHeadlessGunyahProfile(VMConfig vm) {
        vm.item.set("agbot_owner",identity.optString("id"));
        vm.item.set("backend",VMBackend.CROSVM);
        vm.item.set("hypervisor",VMHypervisor.GUNYAH);
        vm.item.set("protected_vm",ProtectedVM.PROTECTED_WITHOUT_FIRMWARE);
        vm.item.set("cpu_count",4L);
        vm.item.set("memory_mb",2048L);
        vm.item.set("swiotlb_mb",256L);
        vm.item.set("hugepages",false);
        vm.item.set("usb",false);
        vm.item.set("pmu",false);
        VMScreenConfig.of(vm.item,VMScreenConfig.ID_GPU0).setEnabled(false);
        VMScreenConfig.of(vm.item,VMScreenConfig.ID_SIMPLEFB).setEnabled(false);
    }

    private void register(File dir,File disk,File seed,boolean vmExists) throws Exception {
        NetworkStore networks=new NetworkStore();
        if(networks.getStoreFile(context).exists()&&!networks.load(context))throw new IOException("网络配置文件损坏；未覆盖");
        VMStore vms=new VMStore();
        if(vms.getStoreFile(context).exists()&&!vms.load(context))throw new IOException("VM 配置文件损坏；未覆盖");

        NetworkConfig network=networks.findById(identity.getString("networkId"));
        if(network==null){
            ArrayList<IPv4Network> used4=new ArrayList<>();ArrayList<IPv6Network> used6=new ArrayList<>();
            NetworkPresets.collectStoreNetworks(networks,null,used4,used6);String[] pair=NetworkPresets.pickFreeCidrPair(used4,used6);
            if(pair==null)throw new IOException("无法分配专用网络地址");
            network=NetworkPresets.routedNat(BridgeType.GVISOR,NetworkPresets.uniqueName(networks,"agbot0"),pair);
            network.setId(identity.getString("networkId"));
            network.item.set("auto_up",false);network.item.set("agbot_loopback_forwards",true);network.item.set("agbot_owner",identity.getString("id"));
            networks.add(network);if(!networks.save(context))throw new IOException("保存网络失败");
        }
        if(!network.item.optString("agbot_owner","").equals(identity.getString("id"))||!network.item.optBoolean("agbot_loopback_forwards",false))
            throw new IOException("网络不属于本 Computer 或转发策略已被修改；未覆盖");
        if(!rpc("network_exists",netArgs()).optBoolean("exists"))rpc("network_create",new JSONObject().put("config",network.toJson()));

        VMConfig vm=vms.findById(identity.getString("id"));
        if(vm==null){
            vm=VMConfig.createWithCustomizeDefaults(context);
            vm.setId(identity.getString("id"));
            vm.setName("Agbot Computer "+identity.getString("id").substring(0,8));
            applyHeadlessGunyahProfile(vm);
            BootConfig boot=BootConfig.of(vm);
            boot.setProtocol(BootConfig.Protocol.LINUX);boot.setLinuxSource(BootConfig.LinuxSource.IMAGE);boot.setImageDisk(0);boot.setBootWait(0);
            boot.setImageCmdline("root=LABEL=cloudimg-rootfs rw console=ttyS0,115200n8 panic=30");
            JSONObject json=vm.toJson().put("peripherals",new JSONArray());
            json.put("disks",new JSONArray()
                .put(new JSONObject().put("path",disk.getPath()).put("bus","virtio").put("readonly",false))
                .put(new JSONObject().put("path",seed.getPath()).put("bus","virtio").put("readonly",true)));
            JSONObject lease=new JSONObject().put("enabled",true).put("offset",64)
                .put("forwards",new JSONArray().put(new JSONObject().put("proto","tcp").put("host",String.valueOf(identity.getInt("hostPort"))).put("guest","8765")));
            json.put("networks",new JSONArray().put(new JSONObject().put("network_id",identity.getString("networkId"))
                .put("mac_address",identity.getString("mac")).put("vlan_id",0).put("dhcp4_lease",lease)));
            vm=new VMConfig(json);
            vms.add(vm);
        }else{
            if(!vm.item.optString("agbot_owner","").equals(identity.getString("id")))throw new IOException("VM 所有权不匹配；未覆盖");
            // Migration is intentionally narrow: preserve disks, NICs, boot image, workspace and identity.
            applyHeadlessGunyahProfile(vm);
        }

        if(!vms.save(context))throw new IOException("保存 VM 失败");
        if(vmExists)rpc("vm_modify",new JSONObject().put("config",vm.toJson()));
        else rpc("vm_create",new JSONObject().put("config",vm.toJson()));
    }

    private void awaitGuest(File dir) throws Exception {
        long deadline=System.nanoTime()+1500_000_000_000L;int stopped=0;String lastPhase="",lastConnection="";
        while(System.nanoTime()<deadline){
            check();
            String state=rpc("vm_status",vmArgs()).optString("state");
            String log=console();diagnostics(dir,log);
            if(state.equals("stopped")||state.equals("failed")||state.equals("error")){
                if(++stopped>5)throw new IOException("Linux VM 提前停止。请导出 Computer 诊断，不需要手工安装 Linux");
            }else stopped=0;
            String pin=Enrollment.verifiedPin(log,identity.getString("id"),identity.getString("token"));
            if(pin!=null){
                JSONObject pairing=new JSONObject().put("gatewayBase","https://127.0.0.1:"+identity.getInt("hostPort"))
                    .put("bridgeToken",identity.getString("token")).put("certificateSha256",pin);
                try{
                    JSONObject health=new GatewayClient(pairing).request("GET","/v1/health",null);
                    if(!health.optBoolean("ok")||!health.optString("instanceId").equals(identity.getString("id"))||health.optInt("uid",0)==0)
                        throw new IOException("Guest 身份或运行用户校验失败");
                    JSONObject before=secrets.read();
                    if(!before.optString("outboxRequestId").isEmpty()&&!before.optString("gatewayBase").equals(pairing.getString("gatewayBase")))
                        throw new IOException("上一台 Computer 消息结果未确认，拒绝更换目标");
                    secrets.update(pairing);
                    stage("READY","Computer 已连接。Linux 与 Agent 已就绪，现在可配置云模型并创建任务");return;
                }catch(IOException e){lastConnection=e.getMessage();}
            }
            String current=log.contains("AGBOT_SETUP_V1 FAILED_RETRYING")?"Guest 初始化遇到错误，自动重试中":
                log.contains("AGBOT_SETUP_V1 INSTALLING_RUNTIME")?"Linux 已启动，正在安装 Node / Codex / Python / Git":
                log.contains("AGBOT_SETUP_V1 SERVICE_STARTED")?"Guest 服务已启动，等待安全配对":"VM 状态："+state+"；等待 Linux 引导与 cloud-init";
            if(!current.equals(lastPhase)){stage("GUEST",current);lastPhase=current;}
            Thread.sleep(3000);
        }
        throw new IOException("等待 Guest 超时；项目磁盘和引导日志已保留，可点重试。"+lastConnection);
    }

    public void stop(boolean force) throws Exception {
        root();directory();connectDaemon();
        if(rpc("vm_exists",vmArgs()).optBoolean("exists")){
            String state=rpc("vm_status",vmArgs()).optString("state");
            if(!state.equals("stopped")){
                stage("STOPPING",force?"强制停止 Computer，未完成磁盘写入可能丢失":"请求 Linux 正常关机，等待磁盘写入完成");
                if(force)rpc("vm_stop",vmArgs());else rpc("vm_control",vmArgs().put("cmd","powerbtn"));
                boolean stopped=false;
                for(int i=0;i<30;i++){Thread.sleep(2000);if(rpc("vm_status",vmArgs()).optString("state").equals("stopped")){stopped=true;break;}}
                if(!stopped)throw new IOException("Linux 未在一分钟内关机；未擅自强停，可检查任务后使用强制停止");
            }
        }
        if(rpc("network_exists",netArgs()).optBoolean("exists")){
            try{rpc("network_stop",netArgs());}catch(Exception ignored){}
        }
        stage("STOPPED","Computer 已停止；重新启动会保留项目和会话");
    }

    public void close(){if(daemon!=null)daemon.close();}
}
