// SPDX-License-Identifier: GPL-3.0-or-later
package app.agbot.android;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** The serial console carries only a certificate pin authenticated by an instance secret. */
public final class Enrollment {
    private static final Pattern PROOF=Pattern.compile("AGBOT_READY_V1 ([0-9a-f-]{36}) ([0-9a-f]{64}) ([0-9a-f]{64})");
    private Enrollment() {}
    public static String proof(String instance,String pin,String token) throws Exception {
        if(!instance.matches("[0-9a-f-]{36}") || !pin.matches("[0-9a-f]{64}") || !token.matches("[A-Za-z0-9_-]{43}"))throw new IllegalArgumentException("Invalid enrollment data");
        Mac mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(token.getBytes(StandardCharsets.UTF_8),"HmacSHA256"));
        byte[] digest=mac.doFinal(("AGBOT_READY_V1\n"+instance+"\n"+pin).getBytes(StandardCharsets.UTF_8));
        StringBuilder result=new StringBuilder();for(byte b:digest)result.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return result.toString();
    }
    public static String verifiedPin(String console,String instance,String token) throws Exception {
        Matcher matcher=PROOF.matcher(console);String result=null;
        while(matcher.find())if(matcher.group(1).equals(instance)){
            String expected=proof(instance,matcher.group(2),token);
            if(MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII),matcher.group(3).getBytes(StandardCharsets.US_ASCII)))result=matcher.group(2);
        }
        return result;
    }
}
