// SPDX-License-Identifier: GPL-3.0-or-later
package app.agbot.android;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.*;

/** User-started foreground lifecycle, separate from the Activity. Never boots automatically on reboot. */
public final class ComputerService extends Service {
    private static final String CHANNEL="agbot-computer";
    private static final int NOTIFICATION=8201;
    private static final java.util.concurrent.atomic.AtomicBoolean ACTIVE=new java.util.concurrent.atomic.AtomicBoolean(false);
    private final ExecutorService executor=Executors.newSingleThreadExecutor();
    private volatile Future<?> task;
    private volatile Thread worker;
    private volatile boolean cancelled=false;
    private final ScheduledExecutorService monitor=Executors.newSingleThreadScheduledExecutor();
    private ScheduledFuture<?> monitorTask;
    private volatile boolean running=false;
    private PowerManager.WakeLock wake;
    public static SharedPreferences status(Context context){return context.getSharedPreferences("agbot.computer.status",MODE_PRIVATE);}
    public static void command(Context context,String action){context.startForegroundService(new Intent(context,ComputerService.class).setAction(action));}
    @Override public void onCreate(){
        super.onCreate();NotificationManager manager=getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL,"Agbot 本地 Computer",NotificationManager.IMPORTANCE_LOW));
        wake=((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"Agbot:Computer");
        wake.setReferenceCounted(false);
    }
    private Notification notification(String text){
        PendingIntent open=PendingIntent.getActivity(this,0,new Intent(this,AgbotActivity.class),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this,CHANNEL).setSmallIcon(android.R.drawable.stat_sys_download_done).setContentTitle("Agbot Computer")
            .setContentText(text).setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).build();
    }
    private void progress(String stage,String message){
        status(this).edit().putString("stage",stage).putString("message",message).putLong("updated",System.currentTimeMillis()).putBoolean("busy",running).apply();
        getSystemService(NotificationManager.class).notify(NOTIFICATION,notification(message));
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        if(Build.VERSION.SDK_INT>=34)startForeground(NOTIFICATION,notification("正在处理 Computer"),ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIFICATION,notification("正在处理 Computer"));
        String action=intent==null?"restore":intent.getAction();
        if("cancel".equals(action)){
            if(running){cancelled=true;if(worker!=null)worker.interrupt();progress("CANCELLING","正在取消，等待有时限的本地操作结束；磁盘和已启动 VM 保留");}
            return START_NOT_STICKY;
        }
        if(running)return START_NOT_STICKY;
        if(!"start".equals(action)&&!"stop".equals(action)&&!"force-stop".equals(action)){
            progress("INTERRUPTED","服务进程重启，请点启动/重连检查真实 VM 状态");stopForeground(STOP_FOREGROUND_REMOVE);stopSelf();return START_NOT_STICKY;
        }
        if(!ACTIVE.compareAndSet(false,true)){progress("BUSY","上一项宿主操作尚未结束，请稍后重试");stopForeground(STOP_FOREGROUND_REMOVE);stopSelf();return START_NOT_STICKY;}
        if(monitorTask!=null)monitorTask.cancel(false);
        cancelled=false;running=true;wake.acquire(45*60*1000L);
        task=executor.submit(()->{
            worker=Thread.currentThread();
            boolean ready=false;
            try(LocalComputer computer=new LocalComputer(this,this::progress)){
                if(cancelled)throw new InterruptedException();
                if("start".equals(action))computer.start();else computer.stop("force-stop".equals(action));
                ready="start".equals(action);
                running=false;status(this).edit().putBoolean("busy",false).apply();
                if(!"start".equals(action)){stopForeground(STOP_FOREGROUND_REMOVE);stopSelf();}
            }catch(Exception e){
                running=false;String message=e instanceof InterruptedException?"操作已中断；磁盘和配置保留":e.getMessage();
                if(message==null)message=e.getClass().getSimpleName();
                try{JSONObject cfg=new SecretStore(this).read();String token=cfg.optJSONObject("computerIdentity")==null?"":cfg.getJSONObject("computerIdentity").optString("token");if(!token.isEmpty())message=message.replace(token,"[REDACTED]");}catch(Exception ignored){}
                if(message.length()>1500)message=message.substring(0,1500);
                progress("ERROR",message+"。可重试或导出诊断");stopForeground(STOP_FOREGROUND_REMOVE);stopSelf();
            }finally{
                ACTIVE.set(false);worker=null;running=false;
                if(ready){
                    monitorTask=monitor.scheduleWithFixedDelay(()->{
                        if(running)return;
                        try{
                            JSONObject cfg=new SecretStore(this).read();JSONObject identity=cfg.optJSONObject("computerIdentity");
                            if(identity==null)return;
                            JSONObject health=new GatewayClient(cfg).request("GET","/v1/health",null);
                            if(!health.optBoolean("ok")||!health.optString("instanceId").equals(identity.getString("id")))throw new Exception("Guest 身份不匹配");
                            // User explicitly keeps a local workstation running; renew a bounded wake lock.
                            wake.acquire(30*60*1000L);progress("READY","Computer 在线；本地 VM 运行中，停止可节省电量");
                        }catch(Exception e){progress("DISCONNECTED","暂时无法连接 Guest；VM 状态未知，请启动/重连检查。未删除项目或重放任务");if(wake.isHeld())wake.release();}
                    },15,30,TimeUnit.SECONDS);
                }else if(wake.isHeld())wake.release();
            }
        });
        return START_NOT_STICKY;
    }
    public static String diagnostics(Context context) throws Exception {
        SharedPreferences st=status(context);StringBuilder out=new StringBuilder("Agbot Computer diagnostics\nversion=0.2.0-dev.1\n");
        out.append("Android=").append(Build.VERSION.RELEASE).append("\ndevice=").append(Build.DEVICE).append("\n")
            .append("stage=").append(st.getString("stage","NOT_CONFIGURED")).append("\nmessage=").append(st.getString("message","")).append('\n');
        JSONObject identity=new SecretStore(context).read().optJSONObject("computerIdentity");
        if(identity!=null){
            String id=identity.getString("id");java.util.UUID.fromString(id);
            File log=new File(context.getFilesDir(),"computer/"+id+"/console.log");
            if(log.isFile()&&log.length()<1024*1024)out.append(Files.readString(log.toPath(),StandardCharsets.UTF_8));
            return out.toString().replace(identity.getString("token"),"[REDACTED]");
        }return out.toString();
    }
    @Override public void onDestroy(){cancelled=true;if(worker!=null)worker.interrupt();executor.shutdown();monitor.shutdownNow();if(wake!=null&&wake.isHeld())wake.release();super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}
}
