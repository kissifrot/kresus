import com.healthmarketscience.jackcess.*;
import com.healthmarketscience.jackcess.crypt.CryptCodecProvider;
import java.io.File;
import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.*;

// Extract only well-understood Money records; unrepresentable accounts are excluded.
public class MoneyReader {
  static String q(String s) {
    if (s == null) return "null";
    StringBuilder b = new StringBuilder("\"");
    for (char c : s.toCharArray()) { if (c == '"' || c == '\\') b.append('\\').append(c); else if (c < 32) b.append(String.format("\\u%04x", (int)c)); else b.append(c); }
    return b.append('"').toString();
  }
  static String str(Row r, String k) { Object v = r.get(k); return v == null ? "" : v.toString().trim(); }
  static long cents(Object v) { return ((BigDecimal)v).movePointRight(2).longValueExact(); }
  static int num(Object v, int fallback) { return v instanceof Number ? ((Number)v).intValue() : fallback; }
  public static void main(String[] args) throws Exception {
    try (Database db = new DatabaseBuilder(new File(args[0])).setReadOnly(true).setCodecProvider(new CryptCodecProvider("")).open()) {
      Map<Integer, Row> cats = new LinkedHashMap<>(), payees = new HashMap<>(), currencies = new HashMap<>();
      for (Row r : db.getTable("CAT")) cats.put(num(r.get("hcat"), -1), r);
      for (Row r : db.getTable("PAY")) payees.put(num(r.get("hpay"), -1), r);
      for (Row r : db.getTable("CRNC")) currencies.put(num(r.get("hcrnc"), -1), r);
      List<String> warnings = new ArrayList<>(), categories = new ArrayList<>(), accounts = new ArrayList<>(), operations = new ArrayList<>();
      Map<Integer, String> paths = new HashMap<>(); Set<String> names = new HashSet<>();
      for (Row c : cats.values()) {
        if (num(c.get("hct"), -1) != 0) continue;
        int level = num(c.get("nLevel"), -1), id = num(c.get("hcat"), -1); String name = str(c, "szFull");
        if (level == 0) continue;
        Row parent = cats.get(num(c.get("hcatParent"), -1));
        String parentName = level == 2 && parent != null ? str(parent, "szFull") : "";
        if (level > 2 || level < 1 || name.isEmpty() || name.length() > 80 || name.contains("·") || (level == 2 && parentName.isEmpty())) throw new Exception("Catégorie Money non prise en charge.");
        String path = parentName.isEmpty() ? name : parentName + " · " + name;
        if (!names.add(path.toLowerCase(Locale.ROOT))) throw new Exception("Catégories Money homonymes : import impossible sans résolution.");
        paths.put(id, path);
        categories.add("{\"id\":"+id+",\"name\":"+q(name)+",\"parentId\":"+(level == 2 ? num(c.get("hcatParent"), -1) : "null")+"}");
      }
      List<Row> allTransactions = new ArrayList<>(); for (Row r : db.getTable("TRN")) allTransactions.add(r);
      if (db.getTable("TRN_SPLIT").getRowCount() > 0 || db.getTable("TRN_XFER").getRowCount() > 0) throw new Exception("UNSUPPORTED_TRANSFERS_OR_SPLITS");
      Set<Integer> splitIds = new HashSet<>(), transferIds = new HashSet<>();
      for (Row r : db.getTable("TRN_SPLIT")) { for (String k : List.of("htrn", "htrnParent")) if (r.get(k) instanceof Number) splitIds.add(num(r.get(k), -1)); }
      for (Row r : db.getTable("TRN_XFER")) { for (String k : List.of("htrnFrom", "htrnLink", "htrn")) if (r.get(k) instanceof Number) transferIds.add(num(r.get(k), -1)); }
      int ignoredAccounts = 0;
      for (Row a : db.getTable("ACCT")) {
        int id = num(a.get("hacct"), -1); Row currency = currencies.get(num(a.get("hcrnc"), -1));
        if (num(a.get("at"), -1) != 0 || currency == null || !"EUR".equals(str(currency, "szIsoCode")) || Boolean.TRUE.equals(a.get("fClosed"))) { ignoredAccounts++; continue; }
        List<String> accountOperations = new ArrayList<>(); long opening = cents(a.get("amtOpen")), balance = opening; boolean unsupported = false;
        for (Row t : allTransactions) {
          if (num(t.get("hacct"), -1) != id || num(t.get("frq"), -1) != -1) continue;
          int trn = num(t.get("htrn"), -1), status = num(t.get("cs"), -1);
          if (t.get("hsec") != null || num(t.get("act"), -1) != -1 || splitIds.contains(trn) || transferIds.contains(trn) || t.get("hacctLink") != null || status < 0 || status > 2 || num(t.get("grftt"), 0) != 0) { unsupported = true; break; }
          long amount = cents(t.get("amt")); if (amount == 0) { unsupported = true; break; } balance = Math.addExact(balance, amount);
          int payeeId = num(t.get("lHpay"), num(t.get("hpay"), -1)); Row payee = payees.get(payeeId);
          String label = payee == null ? "Opération sans destinataire" : str(payee, "szFull"); if (label.isEmpty()) label = "Opération sans destinataire";
          String category = paths.get(num(t.get("hcat"), -1)); if (category == null) category = "Divers";
          String memo = str(t, "mMemo"), reference = str(t, "szId");
          if (!reference.isEmpty()) memo = memo.isEmpty() ? "Référence Money : " + reference : memo + "\nRéférence Money : " + reference;
          String date = ((LocalDateTime)t.get("dt")).toLocalDate().toString();
          accountOperations.add("{\"id\":"+trn+",\"accountId\":"+id+",\"date\":"+q(date)+",\"label\":"+q(label)+",\"category\":"+q(category)+",\"amount\":"+amount+",\"reconciled\":"+(status != 0)+",\"note\":"+q(memo)+"}");
        }
        if (unsupported) { ignoredAccounts++; warnings.add("Un compte bancaire contient des opérations non prises en charge et a été exclu en entier."); continue; }
        accounts.add("{\"id\":"+id+",\"name\":"+q(str(a,"szFull"))+",\"openingBalance\":"+opening+",\"balance\":"+balance+",\"count\":"+accountOperations.size()+"}"); operations.addAll(accountOperations);
      }
      if (ignoredAccounts > 0) warnings.add(ignoredAccounts + " compte(s) non pris en charge ou incomplets sont exclus, notamment les placements.");
      if (db.getTable("BILL").getRowCount() > 0) warnings.add("Les échéances ne sont pas importées.");
      System.out.println("{\"accounts\":["+String.join(",",accounts)+"],\"categories\":["+String.join(",",categories)+"],\"operations\":["+String.join(",",operations)+"],\"warnings\":["+String.join(",",warnings.stream().map(MoneyReader::q).toList())+"]}");
    }
  }
}
