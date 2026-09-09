// SPDX-License-Identifier: GPL-3.0-or-later
import app.agbot.android.SeedDisk;
import java.nio.file.*;
import java.util.LinkedHashMap;
public class SeedHarness {
    public static void main(String[] args) throws Exception {
        if(args.length!=2)throw new IllegalArgumentException("output.img seed-directory");
        LinkedHashMap<String,byte[]> files=new LinkedHashMap<>();
        for(String name:new String[]{"user-data","meta-data","network-config","payload.tgz","agbot.json"}){
            Path path=Path.of(args[1],name);if(Files.exists(path))files.put(name,Files.readAllBytes(path));
        }
        SeedDisk.write(Path.of(args[0]).toFile(),files);
    }
}
