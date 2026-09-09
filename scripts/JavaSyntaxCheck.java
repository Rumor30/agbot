// SPDX-License-Identifier: GPL-3.0-or-later
// Syntax-only Java parser. It does NOT validate Android APIs, resources, types, or produce an APK.
import com.sun.source.util.JavacTask;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import java.util.Arrays;
import java.util.List;

public final class JavaSyntaxCheck {
    public static void main(String[] args) throws Exception {
        if (args.length == 0) throw new IllegalArgumentException("Provide Java source files");
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) throw new IllegalStateException("A JDK, not just a JRE, is required");
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager files = compiler.getStandardFileManager(diagnostics, null, null)) {
            JavacTask task = (JavacTask) compiler.getTask(null, files, diagnostics,
                List.of("-proc:none", "--release", "11"), null, files.getJavaFileObjectsFromStrings(Arrays.asList(args)));
            task.parse();
            boolean failed = false;
            for (Diagnostic<? extends JavaFileObject> d : diagnostics.getDiagnostics()) {
                if (d.getKind() == Diagnostic.Kind.ERROR) { System.err.println(d); failed = true; }
            }
            if (failed) System.exit(1);
        }
        System.out.println("Parsed " + args.length + " Java files. Syntax only: NOT an Android compilation or APK build.");
    }
}
