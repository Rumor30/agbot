#!/usr/bin/env python3
from pathlib import Path

LOCAL = Path('android-overlay/app/src/main/java/app/agbot/android/LocalComputer.java')
PREP = Path('scripts/prepare_android.py')

text = LOCAL.read_text()
marker = '    public void start() throws Exception {\n'
if text.count(marker) != 1:
    raise SystemExit('LocalComputer start marker changed')

helpers = r'''    private List<Integer> ownedDaemonPids() {
        ArrayList<Integer> owned=new ArrayList<>();
        try{
            Shell.Result ids=Shell.cmd("/system/bin/toybox pidof droidvmd 2>/dev/null").exec();
            for(String line:ids.getOut()){
                for(String token:line.trim().split("\\s+")){
                    if(token.isEmpty())continue;
                    int pid;
                    try{pid=Integer.parseInt(token);}catch(NumberFormatException ignored){continue;}
                    if(pid<=1)continue;
                    String command="/system/bin/toybox grep -aFq "+q(context.getPackageName())+
                        " /proc/"+pid+"/environ 2>/dev/null";
                    if(Shell.cmd(command).exec().isSuccess())owned.add(pid);
                }
            }
        }catch(Exception ignored){}
        return owned;
    }

    private void stopOwnedDaemons() throws Exception {
        List<Integer> pids=ownedDaemonPids();
        int registered=DaemonHelper.readPid();
        if(registered>1&&!pids.contains(registered))pids.add(registered);
        for(int pid:pids)Shell.cmd("kill -INT "+pid).exec();

        long graceful=System.nanoTime()+8_000_000_000L;
        while(System.nanoTime()<graceful){
            boolean alive=false;
            for(int pid:pids)if(new File("/proc/"+pid).exists()){alive=true;break;}
            if(!alive)break;
            Thread.sleep(100);
        }
        for(int pid:pids)
            if(new File("/proc/"+pid).exists())Shell.cmd("kill -KILL "+pid).exec();

        long forced=System.nanoTime()+2_000_000_000L;
        while(System.nanoTime()<forced){
            boolean alive=false;
            for(int pid:pids)if(new File("/proc/"+pid).exists()){alive=true;break;}
            if(!alive)return;
            Thread.sleep(100);
        }
        for(int pid:pids)if(new File("/proc/"+pid).exists())
            throw new IOException("旧版内置 DroidVM daemon 无法停止；请重启手机后再试，磁盘未删除");
    }

    private boolean runtimeFilesReady() {
        File data=context.getDataDir();
        for(String relative:new String[]{
            "bin/daemon","bin/netbox","bin/gvswitch","usr/bin/crosvm","usr/bin/qemu-img"
        }){
            File f=new File(data,relative);
            if(!f.isFile()||!f.canExecute())return false;
        }
        return true;
    }

    private boolean runDirectoryReady() {
        File run=new File(context.getDataDir(),"run");
        return run.isDirectory()&&run.canRead()&&run.canWrite()&&run.canExecute();
    }

    private void ensureRunDirectory() throws Exception {
        File run=new File(context.getDataDir(),"run");
        if(!run.isDirectory()&&!run.mkdirs())
            throw new IOException("不能创建内置 DroidVM 运行目录 "+run);
        int uid=android.os.Process.myUid();
        Shell.Result result=Shell.cmd("chown "+uid+":"+uid+" "+q(run.getPath())+
            " && chmod 700 "+q(run.getPath())).exec();
        if(!result.isSuccess()||!run.isDirectory())
            throw new IOException("不能修复内置 DroidVM 运行目录权限");
    }

    private void prepareRuntime() throws Exception {
        stage("RUNTIME","校验 APK 内固定版本虚拟化运行时与 root daemon");
        long packageVersion=context.getPackageManager()
            .getPackageInfo(context.getPackageName(),0).getLongVersionCode();
        long prepared=context.getSharedPreferences("agbot.runtime",Context.MODE_PRIVATE)
            .getLong("version",-1L);
        boolean stalePackage=prepared!=packageVersion;
        boolean brokenFiles=!runtimeFilesReady()||AssetUtils.needsExtractPrebuilt(context);
        boolean brokenRun=!runDirectoryReady();
        boolean registeredRunning=DaemonHelper.isDaemonRunning();
        List<Integer> owned=ownedDaemonPids();
        boolean daemonRunning=registeredRunning||!owned.isEmpty();
        boolean daemonStateBad=owned.size()>1||(!owned.isEmpty()&&!registeredRunning);

        if(daemonRunning&&(stalePackage||brokenFiles||brokenRun||daemonStateBad)){
            stage("RUNTIME_RESTART","检测到 APK 更新、运行时缺失或残留 root daemon；自动清理 Agbot 自己的旧 daemon，Linux 磁盘保留");
            stopOwnedDaemons();
            daemonRunning=DaemonHelper.isDaemonRunning()||!ownedDaemonPids().isEmpty();
            if(daemonRunning)
                throw new IOException("旧版内置 DroidVM daemon 仍在运行；拒绝覆盖其运行时");
        }

        if(!daemonRunning){
            // Every write here is hash-checked by DroidVM. This repairs exactly the failure seen
            // on Warsaw where a root daemon survived an APK update while netbox/gvswitch vanished.
            AssetUtils.extractBinaries(context);
            AssetUtils.extractLibraries(context);
            AssetUtils.extractPrebuilt(context);
        }
        ensureRunDirectory();

        if(AssetUtils.needsExtractPrebuilt(context)||!runtimeFilesReady())
            throw new IOException("内置 DroidVM 运行时不完整（netbox/gvswitch/crosvm）；已停止启动，磁盘未删除");
        context.getSharedPreferences("agbot.runtime",Context.MODE_PRIVATE).edit()
            .putLong("version",packageVersion).apply();
        stage("RUNTIME_OK","运行时完整；root daemon 与当前 APK 版本一致");
    }

'''
text = text.replace(marker, helpers + marker, 1)

old = '''        stage("RUNTIME","准备 APK 内固定版本虚拟化运行时");
        if(!DaemonHelper.isDaemonRunning()){
            AssetUtils.extractBinaries(context);
            AssetUtils.extractLibraries(context);
            AssetUtils.extractPrebuilt(context);
        }else if(AssetUtils.needsExtractPrebuilt(context)){
            throw new IOException("运行时需要更新，但 daemon 正在运行；请在高级管理器停止 VM/daemon 后重试");
        }
'''
if text.count(old) != 1:
    raise SystemExit('LocalComputer runtime block changed')
text = text.replace(old, '        prepareRuntime();\n', 1)
LOCAL.write_text(text)

prep = PREP.read_text()
if prep.count('versionCode = 4') != 1:
    raise SystemExit('versionCode transform changed')
if prep.count('versionName = "0.2.0-dev.3"') != 1:
    raise SystemExit('versionName transform changed')
prep = prep.replace('versionCode = 4', 'versionCode = 5', 1)
prep = prep.replace('versionName = "0.2.0-dev.3"', 'versionName = "0.2.0-dev.4"', 1)
PREP.write_text(prep)
print('dev.4 runtime lifecycle patch applied')
