#!/usr/bin/env bash
# 一鍵測試：假 Supabase + 本機 wrangler dev + 伺服器協定測試 + 客戶端冒煙測試
# 需求：Node 22+、已在專案資料夾執行 npm install（wrangler）
cd "$(dirname "$0")/.."
pkill -x workerd 2>/dev/null; sleep 1   # 清掉上次殘留的本機伺服器
node tests/mock-supabase.mjs & MOCK=$!
# 把伺服器時間調成「夜晚」（睡覺投票測試用）：tod = (秒/240 + 0.1) % 1，目標 0.6
OFFSET=$(node -e "const n=Date.now();console.log(Math.round((((120-(n/1000)%240)+240)%240)*1000))")
npx wrangler dev --port 8787 --ip 127.0.0.1 \
  --var SUPABASE_URL:http://127.0.0.1:9999 --var SUPABASE_ANON_KEY:anon --var SUPABASE_SERVICE_KEY:svc \
  --var REQUIRE_LOGIN:0 --var DEV_TIME_OFFSET_MS:$OFFSET > /tmp/wrangler-test.log 2>&1 & WR=$!
for i in $(seq 1 60); do grep -q "Ready on" /tmp/wrangler-test.log && break; sleep 1; done
sleep 2
node tests/server.test.mjs; CODE=$?
node tests/client-smoke.js solo || CODE=1
node tests/client-smoke.js online || CODE=1
kill $WR $MOCK 2>/dev/null; pkill -x workerd 2>/dev/null
exit $CODE
