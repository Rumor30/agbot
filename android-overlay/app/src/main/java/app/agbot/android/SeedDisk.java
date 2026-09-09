// SPDX-License-Identifier: GPL-3.0-or-later
package app.agbot.android;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/** Small, deterministic FAT16 NoCloud seed. No native command or root needed to generate it. */
public final class SeedDisk {
    private static final int SECTOR=512, SECTORS=16384, FAT_SECTORS=64, ROOT_SECTORS=32;
    private static final int ROOT_START=1+2*FAT_SECTORS, DATA_START=ROOT_START+ROOT_SECTORS;
    private SeedDisk() {}
    private static void u16(byte[] a,int o,int v){a[o]=(byte)v;a[o+1]=(byte)(v>>>8);}
    private static void u32(byte[] a,int o,long v){for(int i=0;i<4;i++)a[o+i]=(byte)(v>>>(8*i));}
    private static void str(byte[] a,int o,String s){byte[] b=s.getBytes(StandardCharsets.US_ASCII);System.arraycopy(b,0,a,o,b.length);}
    public static void write(File target, LinkedHashMap<String,byte[]> files) throws IOException {
        if (target.exists()) throw new IOException("Seed destination must be new");
        if (files.isEmpty() || files.size()>32) throw new IOException("Invalid seed file count");
        java.util.HashSet<String> names=new java.util.HashSet<>();
        long size=0; for(Map.Entry<String,byte[]> e:files.entrySet()){
            if(!e.getKey().matches("[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}") || e.getValue()==null)throw new IOException("Invalid seed entry");
            if(!names.add(e.getKey().toLowerCase(java.util.Locale.ROOT)))throw new IOException("Duplicate FAT name");
            size+=(e.getValue().length+511L)/512;
        }
        if(size>SECTORS-DATA_START-2)throw new IOException("Seed payload exceeds FAT image capacity");
        byte[] boot=new byte[512];boot[0]=(byte)0xeb;boot[1]=0x3c;boot[2]=(byte)0x90;str(boot,3,"AGBOT   ");
        u16(boot,11,512);boot[13]=1;u16(boot,14,1);boot[16]=2;u16(boot,17,512);u16(boot,19,SECTORS);
        boot[21]=(byte)0xf8;u16(boot,22,FAT_SECTORS);u16(boot,24,32);u16(boot,26,64);
        boot[36]=(byte)0x80;boot[38]=0x29;u32(boot,39,0x41474232);str(boot,43,"CIDATA     ");str(boot,54,"FAT16   ");
        boot[510]=0x55;boot[511]=(byte)0xaa;
        byte[] fat=new byte[FAT_SECTORS*512],dir=new byte[ROOT_SECTORS*512];u16(fat,0,0xfff8);u16(fat,2,0xffff);
        str(dir,0,"CIDATA     ");dir[11]=8;int entry=1,cluster=2,index=0;
        try(RandomAccessFile out=new RandomAccessFile(target,"rw")){
            out.setLength((long)SECTORS*512);out.seek(0);out.write(boot);
            for(Map.Entry<String,byte[]> f:files.entrySet()){
                String name=f.getKey();byte[] bytes=f.getValue();String alias=String.format(java.util.Locale.ROOT,"FILE%04dDAT",++index);
                byte[] shortname=alias.getBytes(StandardCharsets.US_ASCII);int checksum=0;
                for(byte b:shortname)checksum=(((checksum&1)<<7)+(checksum>>>1)+(b&255))&255;
                int slots=(name.length()+12)/13;
                for(int seq=slots;seq>0;seq--){
                    int o=entry++*32;dir[o]=(byte)(seq|(seq==slots?0x40:0));dir[o+11]=0x0f;dir[o+13]=(byte)checksum;
                    int[] offsets={1,3,5,7,9,14,16,18,20,22,24,28,30};
                    for(int j=0;j<13;j++){int n=(seq-1)*13+j;u16(dir,o+offsets[j],n<name.length()?name.charAt(n):n==name.length()?0:0xffff);}
                }
                int o=entry++*32;System.arraycopy(shortname,0,dir,o,11);dir[o+11]=0x20;u16(dir,o+24,0x5821);
                u16(dir,o+26,bytes.length==0?0:cluster);u32(dir,o+28,bytes.length);
                int count=(bytes.length+511)/512;
                for(int j=0;j<count;j++)u16(fat,(cluster+j)*2,j==count-1?0xffff:cluster+j+1);
                out.seek((long)(DATA_START+cluster-2)*512);out.write(bytes);cluster+=count;
            }
            out.seek(512);out.write(fat);out.write(fat);out.seek((long)ROOT_START*512);out.write(dir);out.getFD().sync();
        } catch(IOException e){if(!target.delete())e.addSuppressed(new IOException("Partial seed remains: "+target));throw e;}
    }
}
