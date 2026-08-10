curl -s -m 8 --compressed 'https://emweb.securities.eastmoney.com/HK_HSF10/CompanySurvey/PageAjax?code=00700' > /tmp/opencode/f10_00700.json
node -e '
const j = require("/tmp/opencode/f10_00700.json");
const keys = Object.keys(j);
console.log("top keys:", keys.join(", "));
for (const k of keys) {
  const v = j[k];
  if (v && typeof v === "object" && v[0]) {
    const o = v[0];
    console.log(`\n== ${k} == keys:`, Object.keys(o).slice(0, 30).join(", "));
    for (const [kk, vv] of Object.entries(o)) {
      if (typeof vv === "string" && vv.length > 60) console.log(`  ${kk}: ${vv.slice(0,120)}...`);
    }
  }
}'
