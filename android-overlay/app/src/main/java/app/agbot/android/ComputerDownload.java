// SPDX-License-Identifier: GPL-3.0-or-later
package app.agbot.android;
import java.io.*;
import java.net.URL;
import java.security.MessageDigest;
import javax.net.ssl.HttpsURLConnection;

/** Bounded HTTPS download with resumable temporary file and pinned SHA-256. */
public final class ComputerDownload {
    public interface Progress { void update(long bytes) throws Exception; }
    private static final long LIMIT=512L*1024*1024;
    private ComputerDownload() {}
    private static String hash(File f) throws Exception {
        MessageDigest d=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(f)){
            byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1){if(Thread.currentThread().isInterrupted())throw new InterruptedException();d.update(b,0,n);}
        }StringBuilder s=new StringBuilder();for(byte b:d.digest())s.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return s.toString();
    }
    public static void fetch(String url,String sha,File destination,Progress progress) throws Exception {
        if(destination.isFile()){
            if(hash(destination).equals(sha))return;
            throw new IOException("已有镜像校验失败；保留文件供检查，没有静默覆盖");
        }
        File part=new File(destination.getPath()+".partial");long offset=part.isFile()?part.length():0;
        if(offset>LIMIT)throw new IOException("下载临时文件过大");
        HttpsURLConnection connection=(HttpsURLConnection)new URL(url).openConnection();
        connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(20000);connection.setReadTimeout(20000);
        connection.setRequestProperty("Accept-Encoding","identity");if(offset>0)connection.setRequestProperty("Range","bytes="+offset+"-");
        try{
            int status=connection.getResponseCode();
            if(status==416 && offset>0 && hash(part).equals(sha)){if(!part.renameTo(destination))throw new IOException("镜像提交失败");return;}
            if(status!=200 && status!=206)throw new IOException("Linux 镜像服务器 HTTP "+status);
            if(status==200)offset=0;
            else if(!String.valueOf(connection.getHeaderField("Content-Range")).startsWith("bytes "+offset+"-"))throw new IOException("镜像断点范围不匹配");
            long length=connection.getContentLengthLong();if(length>LIMIT-offset)throw new IOException("镜像超出大小限制");
            try(InputStream in=connection.getInputStream();FileOutputStream out=new FileOutputStream(part,offset>0)){
                byte[] b=new byte[65536];long total=offset,last=0,start=System.nanoTime();int n;
                while((n=in.read(b))!=-1){
                    if(Thread.currentThread().isInterrupted())throw new InterruptedException();
                    total+=n;if(total>LIMIT || System.nanoTime()-start>1800_000_000_000L)throw new IOException("下载超出时间或大小上限");
                    out.write(b,0,n);long now=System.nanoTime();if(now-last>1_000_000_000L){progress.update(total);last=now;}
                }out.getFD().sync();
            }
        }finally{connection.disconnect();}
        if(!hash(part).equals(sha)){
            File bad=new File(part.getPath()+".invalid");if(!part.renameTo(bad))throw new IOException("镜像校验失败，临时文件未移动");
            throw new IOException("Linux 镜像 SHA-256 不符，未启动；可重试重新下载");
        }
        if(!part.renameTo(destination))throw new IOException("镜像提交失败");
    }
}
