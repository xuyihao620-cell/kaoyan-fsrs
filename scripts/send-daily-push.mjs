import crypto from "node:crypto";
import fs from "node:fs";

let GIST_ID = (process.env.GIST_ID || "").trim();
const GIST_TOKEN = (process.env.GIST_TOKEN || "").trim();
const VAPID_PEM = (process.env.VAPID_PEM || "").trim();
const FORCE_TEST = process.env.FORCE_TEST === "true";

function b64uEncode(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64uDecode(str) {
  const s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, "base64");
}

async function readGistFileText(fObj) {
  if (!fObj) return null;
  if (fObj.truncated && fObj.raw_url) {
    const r = await fetch(fObj.raw_url, {
      headers: { "User-Agent": "kaoyan-fsrs-push" }
    });
    if (r.ok) return await r.text();
  }
  return typeof fObj.content === "string" ? fObj.content : null;
}

async function discoverGistId(token) {
  if (!token) return "";
  try {
    const r = await fetch(`https://api.github.com/gists?per_page=30&_t=${Date.now()}`, {
      headers: {
        "Authorization": `token ${token}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "kaoyan-fsrs-push"
      }
    });
    if (!r.ok) return "";
    const list = await r.json();
    if (Array.isArray(list)) {
      for (const g of list) {
        const f = (g && g.files) || {};
        if (f["kaoyan_global_sync.json"] || f["kaoyan_201_fsrs_sync.json"] || f["kaoyan_math_fsrs_sync.json"]) {
          return g.id;
        }
      }
    }
  } catch (e) {}
  return "";
}

function createVapidJwt(endpoint, vapidPem) {
  const origin = new URL(endpoint).origin;
  const header = b64uEncode(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = b64uEncode(JSON.stringify({
    aud: origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: "mailto:kaoyan-fsrs@users.noreply.github.com"
  }));
  const unsigned = `${header}.${payload}`;
  const sig = crypto.sign("sha256", Buffer.from(unsigned), {
    key: vapidPem,
    dsaEncoding: "ieee-p1363"
  });
  return `${unsigned}.${b64uEncode(sig)}`;
}

// RFC 8291 (aes128gcm) Web Push Payload Encryption
function encryptWebPushPayload(plaintextStr, p256dhB64u, authB64u) {
  const uaPublic = b64uDecode(p256dhB64u);
  const authSecret = b64uDecode(authB64u);

  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  const salt = crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));

  const cekInfo = Buffer.from("Content-Encoding: aes128gcm\0", "utf8");
  const nonceInfo = Buffer.from("Content-Encoding: nonce\0", "utf8");
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, cekInfo, 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, nonceInfo, 12));

  const padded = Buffer.concat([Buffer.from(plaintextStr, "utf8"), Buffer.from([2])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(4096, 0);
  const idLenBuf = Buffer.from([asPublic.length]);
  return Buffer.concat([salt, rsBuf, idLenBuf, asPublic, encrypted]);
}

function minsSinceRollover(hhmm, rh) {
  const parts = String(hhmm || "08:00").split(":").map(Number);
  const h = Number.isFinite(parts[0]) ? parts[0] : 8;
  const m = Number.isFinite(parts[1]) ? parts[1] : 0;
  const diff = (h * 60 + m) - rh * 60;
  return diff < 0 ? diff + 1440 : diff;
}

function bjDayStart(ms, rh) {
  const shifted = new Date(ms + (8 - rh) * 3600000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), rh - 8, 0, 0, 0);
}

function effectiveDue(st, rh) {
  if (!st) return Infinity;
  if (st.state === "review" && st.ivl >= 1 && st.lastReview > 0) {
    const days = Math.max(1, Math.round(st.ivl || 1));
    return bjDayStart(st.lastReview, rh) + days * 86400000;
  }
  return typeof st.due === "number" ? st.due : Infinity;
}

async function main() {
  if (!GIST_ID && GIST_TOKEN) {
    GIST_ID = await discoverGistId(GIST_TOKEN);
  }
  if (!GIST_ID) {
    console.log("No GIST_ID configured in Secrets and unable to auto-discover via GIST_TOKEN.");
    return;
  }
  const reqHeaders = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "kaoyan-fsrs-push"
  };
  if (GIST_TOKEN) {
    reqHeaders["Authorization"] = `token ${GIST_TOKEN}`;
  } else if (process.env.GITHUB_TOKEN) {
    reqHeaders["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  let resp = await fetch(`https://api.github.com/gists/${GIST_ID}?_t=${Date.now()}`, {
    headers: reqHeaders
  });
  if (resp.status === 404 && GIST_TOKEN) {
    const discovered = await discoverGistId(GIST_TOKEN);
    if (discovered && discovered !== GIST_ID) {
      GIST_ID = discovered;
      resp = await fetch(`https://api.github.com/gists/${GIST_ID}?_t=${Date.now()}`, {
        headers: reqHeaders
      });
    }
  }
  if (!resp.ok && reqHeaders["Authorization"]) {
    delete reqHeaders["Authorization"];
    resp = await fetch(`https://api.github.com/gists/${GIST_ID}?_t=${Date.now()}`, {
      headers: reqHeaders
    });
  }
  let files = {};
  if (resp.ok) {
    const gist = await resp.json();
    files = gist.files || {};
  } else {
    console.warn(`API returned ${resp.status}, falling back to raw gist URLs...`);
    const names = ["kaoyan_global_sync.json", "kaoyan_201_fsrs_sync.json", "kaoyan_math_fsrs_sync.json"];
    await Promise.all(names.map(async name => {
      const r = await fetch(`https://gist.githubusercontent.com/raw/${GIST_ID}/${name}?_t=${Date.now()}`);
      if (r.ok) files[name] = { content: await r.text() };
    }));
  }

  const globalRaw = await readGistFileText(files["kaoyan_global_sync.json"]);
  if (!globalRaw) {
    console.log("No kaoyan_global_sync.json found in Gist.");
    return;
  }
  const globalCfg = JSON.parse(globalRaw);
  const rolloverHour = Number.isInteger(globalCfg.rolloverHour) ? globalCfg.rolloverHour : 4;
  const remindTime = globalCfg.remindTime || "08:00";
  const subs = Array.isArray(globalCfg.subscriptions) ? globalCfg.subscriptions : [];

  if (!subs.length) {
    console.log("No active Web Push subscriptions registered yet.");
    return;
  }

  const nowMs = Date.now();
  const bjNow = new Date(nowMs + 8 * 3600000);
  const currentHHMM = bjNow.toISOString().slice(11, 16);
  const bjShifted = new Date(nowMs + (8 - rolloverHour) * 3600000);
  const todayKey = bjShifted.toISOString().slice(0, 10);

  // Count due items across English & Math (100% aligned with DueBell.collect & rolloverHour)
  let enDue = 0;
  let mathDue = 0;
  let coreWordSet = null;
  try {
    const bundleTxt = fs.readFileSync(new URL("../app-bundle.js", import.meta.url), "utf8");
    const m = bundleTxt.match(/const RAW_DATA = (\{.*?\});\n/);
    if (m) {
      const rawData = JSON.parse(m[1]);
      if (Array.isArray(rawData.words)) {
        coreWordSet = new Set(rawData.words.filter(w => w && w.isCore).map(w => w.w));
      }
    }
  } catch (e) {}

  try {
    const enRaw = await readGistFileText(files["kaoyan_201_fsrs_sync.json"]);
    if (enRaw) {
      const enData = JSON.parse(enRaw);
      const stMap = enData.state || {};
      for (const k of Object.keys(stMap)) {
        if (coreWordSet && !coreWordSet.has(k)) continue;
        const st = stMap[k];
        if (st && st.reps > 0 && effectiveDue(st, rolloverHour) <= nowMs) enDue++;
      }
    }
  } catch (e) {}

  try {
    const mathRaw = await readGistFileText(files["kaoyan_math_fsrs_sync.json"]);
    if (mathRaw) {
      const mathData = JSON.parse(mathRaw);
      const items = mathData.items || {};
      const dueCards = new Set(Array.isArray(mathData.partialCards) ? mathData.partialCards : []);
      for (const k of Object.keys(items)) {
        const st = items[k];
        if (st && st.reps > 0 && effectiveDue(st, rolloverHour) <= nowMs) {
          dueCards.add(k.split("::")[0]);
        }
      }
      mathDue = dueCards.size;
    }
  } catch (e) {}

  const totalDue = mathDue + enDue;
  console.log(`[Check] Beijing=${currentHHMM}, FSRS_Day=${todayKey}, Remind=${remindTime}, Due=${totalDue} (Math=${mathDue}, En=${enDue}), Force=${FORCE_TEST}`);

  if (!FORCE_TEST) {
    if (remindTime === "off") {
      console.log("Daily reminder is turned off.");
      return;
    }
    if (globalCfg.lastNotifiedDay === todayKey) {
      console.log(`Already notified for FSRS day ${todayKey}.`);
      return;
    }
    const nowMins = minsSinceRollover(currentHHMM, rolloverHour);
    const targetMins = minsSinceRollover(remindTime, rolloverHour);
    const deltaMins = nowMins - targetMins;
    if (deltaMins < 0 || deltaMins > 180) {
      console.log(`Outside reminder window (nowMins=${nowMins}, targetMins=${targetMins}).`);
      return;
    }
    if (totalDue <= 0) {
      console.log("0 cards due today; marking day notified without disturbing user.");
      await updateGistState(globalCfg, todayKey, subs);
      return;
    }
  }

  const title = FORCE_TEST
    ? "🔔 卡片盒锁屏推送测试成功"
    : `📅 今日复习时间到（${remindTime}）`;
  const subParts = [];
  if (mathDue > 0) subParts.push(`数学 ${mathDue} 题`);
  if (enDue > 0) subParts.push(`英语 ${enDue} 词`);
  const body = totalDue > 0
    ? `今日共有 ${totalDue} 张卡片待复习（${subParts.join(" · ")}），点击直接打开卡片盒`
    : `当前待复习卡片已清零！每日将于 ${remindTime === "off" ? "设定时间" : remindTime} 准时提醒您`;

  const validSubs = [];
  let sentCount = 0;

  for (const sub of subs) {
    if (!sub || !sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) continue;
    try {
      const subPayloadStr = JSON.stringify({
        title,
        body,
        tag: FORCE_TEST ? `kaoyan-test-${Date.now()}` : `kaoyan-daily-${todayKey}`,
        url: sub.pageUrl || "./",
        totalDue,
        mathDue,
        enDue
      });
      const vapidPemToUse = VAPID_PEM || globalCfg.vapidPem;
      if (!vapidPemToUse) {
        console.error("Missing VAPID_PEM in GitHub Actions Secrets.");
        continue;
      }
      const jwt = createVapidJwt(sub.endpoint, vapidPemToUse);
      const encryptedBody = encryptWebPushPayload(subPayloadStr, sub.keys.p256dh, sub.keys.auth);
      const vapidPubToUse = globalCfg.vapidPublicKey || "BCv4X_HhoE7qEjKth8Fu1BeEW_GjARD_RzjZq6Ax92TLLZYdZuGZWqbcaJV8wiKM4uJ_ctaYm0jXHjNOVBhBi5w";
      const pushResp = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          "Authorization": `vapid t=${jwt}, k=${vapidPubToUse}`,
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          "TTL": "86400",
          "Urgency": "high"
        },
        body: encryptedBody
      });
      console.log(`Push to ${sub.label || "device"} (${new URL(sub.endpoint).host}): HTTP ${pushResp.status}`);
      if (pushResp.status === 404 || pushResp.status === 410) {
        console.log("Removing expired subscription.");
      } else {
        validSubs.push(sub);
        if (pushResp.ok) sentCount++;
      }
    } catch (e) {
      console.error("Push error:", e.message);
      validSubs.push(sub);
    }
  }

  if (!FORCE_TEST && sentCount > 0) {
    await updateGistState(globalCfg, todayKey, validSubs);
  } else if (validSubs.length !== subs.length) {
    await updateGistState(globalCfg, globalCfg.lastNotifiedDay || "", validSubs);
  }
}

async function updateGistState(globalCfg, lastNotifiedDay, validSubs) {
  const token = GIST_TOKEN;
  if (!token || !GIST_ID) return;
  const nextCfg = {
    ...globalCfg,
    lastNotifiedDay,
    subscriptions: validSubs,
    updatedAt: Date.now()
  };
  delete nextCfg.syncAuth;
  delete nextCfg.vapidPem;
  delete nextCfg.vapidPrivateKey;
  await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: {
      "Authorization": `token ${token}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "kaoyan-fsrs-push"
    },
    body: JSON.stringify({
      files: {
        "kaoyan_global_sync.json": {
          content: JSON.stringify(nextCfg, null, 2)
        }
      }
    })
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
