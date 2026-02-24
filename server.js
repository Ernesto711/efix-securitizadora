/**
 * EFIX Securitizadora — Server v3.0
 * - iHold Banking API: saldo real, extrato, conciliação automática
 * - Polygon NFT: CR como ERC721 negociável
 * - Persistência em JSON
 */
const express = require("express");
const crypto = require("crypto");
const https = require("https");
const path = require("path");
const fs = require("fs");

const PORT = parseInt(process.env.PORT || "3000");
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "recebiveis.json");
const NFT_FILE = path.join(DATA_DIR, "nfts.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const IHOLD = {
  baseUrl: process.env.PROD_HAUSBANK_API_URL || "https://haus-api2.iholdbank.digital/api",
  clientId: process.env.PROD_HAUSBANK_API_KEY || "a0f23d86-fc7b-479b-b359-956c126a5597",
  clientSecret: process.env.PROD_HAUSBANK_SECRET || "D86RR8C0mPCiKYFdK7QzIW4F28Ng8gjER51sY3PR",
};
const POLY = {
  rpc: process.env.POLYGON_RPC_URL || "https://polygon-mainnet.g.alchemy.com/v2/5QrXWREEtmi4gITNoJsJf",
  key: process.env.DEPLOYER_PRIVATE_KEY || "8a997073e519fad0b622af2c07945cc8e3cc19c2207e440c1bc4162924d4842d",
  nft: process.env.NFT_CONTRACT_ADDRESS || "",
};

/* ── NFT ABI (human-readable) ── */
const NFT_ABI = [
  "function mint(address to, string uri) returns (uint256)",
  "function burn(uint256 id)",
  "function tokenURI(uint256 id) view returns (string)",
  "function ownerOf(uint256 id) view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function transferFrom(address from, address to, uint256 id)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

let NFT_BYTECODE = "";
try {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, "EFIX_CR_compiled.json"), "utf8"));
  NFT_BYTECODE = c.bytecode;
} catch {}

/* ── JSON persistence ── */
function loadJ(f, d) { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d; } catch { return d; } }
function saveJ(f, d) { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch (e) { console.error("Save err:", e.message); } }

let recebiveis = loadJ(DATA_FILE, []);
let nfts = loadJ(NFT_FILE, []);

const PARAMS_FILE = path.join(DATA_DIR, "params.json");
let params = loadJ(PARAMS_FILE, {
  txDesconto: 2.50, royalty: 1.00, prazoSider: 30, prazoMercado: 3,
  irRegressivo: [22.5, 20, 17.5, 15],
  nomeSecuritizadora: "EFIX Securitizadora S.A.",
  cnpjSecuritizadora: "60.756.859/0001-57",
  contaBanco: "Bco 332 \xb7 Ag 0001 \xb7 Conta Segregada"
});

/* ══════════════════════════════════════════════════════
   iHOLD BANKING API
   ══════════════════════════════════════════════════════ */
class IHold {
  constructor(cfg) { this.cfg = cfg; this.token = null; this.exp = 0; }

  _req(method, urlPath, data) {
    const base = this.cfg.baseUrl.replace(/\/+$/, "");
    const url = urlPath.startsWith("/api/") ? base.replace(/\/api$/, "") + urlPath : base + urlPath;
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const hdrs = { "Content-Type": "application/json", Accept: "application/json" };
      if (this.token && !urlPath.includes("/identity_server/")) hdrs.Authorization = "Bearer " + this.token;
      const body = data ? JSON.stringify(data) : null;
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: hdrs }, res => {
        let raw = ""; res.on("data", c => raw += c);
        res.on("end", () => {
          let p; try { p = JSON.parse(raw); } catch { p = raw; }
          res.statusCode < 300 ? resolve({ status: res.statusCode, data: p }) : reject(new Error("iHold " + res.statusCode + ": " + raw.slice(0, 300)));
        });
      });
      req.on("error", reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
      if (body) req.write(body); req.end();
    });
  }

  async auth() {
    try {
      const r = await this._req("POST", "/api/identity_server/oauth/tokens", {
        grant_type: "client_credentials", client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, scopes: ["*"],
      });
      this.token = r.data.access_token;
      this.exp = Date.now() + ((r.data.expires_in || 3600) - 120) * 1000;
      console.log("● iHold auth OK, expires in", r.data.expires_in, "s");
      return true;
    } catch (e) { console.error("✖ iHold auth:", e.message); return false; }
  }

  async ok() { if (!this.token || Date.now() >= this.exp) return this.auth(); return true; }

  async balance() { await this.ok(); return this._req("GET", "/api/accounts"); }

  async statements(from, to) {
    await this.ok();
    const p = new URLSearchParams();
    p.set("include", "payload,transactionType,status");
    if (from && to) p.set("filter[between_dates]", from + "," + to);
    p.set("page[size]", "100");
    return this._req("GET", "/api/statements?" + p.toString());
  }
}

/* ══════════════════════════════════════════════════════
   POLYGON NFT SERVICE
   ══════════════════════════════════════════════════════ */
let ethers;
try { ethers = require("ethers"); } catch { console.warn("⚠ ethers not installed"); }

class NFTSvc {
  constructor() { this.provider = null; this.wallet = null; this.contract = null; this.addr = POLY.nft; this.ready = false; }

  async connect() {
    if (!ethers || !POLY.key) return false;
    try {
      this.provider = new ethers.JsonRpcProvider(POLY.rpc);
      this.wallet = new ethers.Wallet(POLY.key, this.provider);
      const bal = await this.provider.getBalance(this.wallet.address);
      console.log("● Polygon:", this.wallet.address, "MATIC:", ethers.formatEther(bal));
      if (this.addr) {
        this.contract = new ethers.Contract(this.addr, NFT_ABI, this.wallet);
        const s = await this.contract.totalSupply();
        console.log("● NFT:", this.addr, "supply:", s.toString());
        this.ready = true;
      }
      return true;
    } catch (e) { console.error("✖ Polygon:", e.message); return false; }
  }

  async deploy() {
    if (!NFT_BYTECODE) throw new Error("Bytecode missing — need EFIX_CR_compiled.json");
    console.log("● Deploying EFIX_CR NFT...");
    const f = new ethers.ContractFactory(NFT_ABI, NFT_BYTECODE, this.wallet);
    const c = await f.deploy();
    await c.waitForDeployment();
    this.addr = await c.getAddress();
    this.contract = new ethers.Contract(this.addr, NFT_ABI, this.wallet);
    this.ready = true;
    console.log("● NFT deployed:", this.addr);
    return this.addr;
  }

  async mint(to, metadata) {
    if (!this.ready) throw new Error("Contract not deployed");
    const uri = "data:application/json;base64," + Buffer.from(JSON.stringify(metadata)).toString("base64");
    const tx = await this.contract.mint(to, uri);
    const receipt = await tx.wait();
    const tLog = receipt.logs.find(l => l.topics && l.topics[0] === ethers.id("Transfer(address,address,uint256)"));
    const tokenId = tLog ? parseInt(tLog.topics[3], 16) : null;
    return { tokenId, txHash: receipt.hash, contract: this.addr, block: receipt.blockNumber };
  }

  async status() {
    if (!this.ready) return { ready: false };
    const s = await this.contract.totalSupply();
    const b = await this.provider.getBalance(this.wallet.address);
    return { ready: true, address: this.addr, supply: Number(s), operator: this.wallet.address, matic: ethers.formatEther(b) };
  }
}

/* ══════════════════════════════════════════════════════
   RECONCILIATION ENGINE
   ══════════════════════════════════════════════════════ */
function reconcile(recs, stmts) {
  const matches = [];
  const ativos = recs.filter(r => r.status === "ativo");
  const used = new Set();

  for (const st of stmts) {
    const amt = Number(st.amount || st.value || 0);
    if (amt <= 0) continue;
    const desc = (st.description || st.complement || "").toUpperCase();
    const date = (st.created_at || st.date || new Date().toISOString()).split("T")[0];
    const sid = st.id || st.txid || crypto.randomUUID();

    for (const r of ativos) {
      if (used.has(r.id)) continue;
      // Exact match
      if (Math.abs(r.valor - amt) <= 0.01) {
        used.add(r.id);
        matches.push({ recId: r.id, dupl: r.dupl, valorFace: r.valor, valorPago: amt, sacado: r.sacado, stmtId: sid, desc, date, conf: "exact" });
        break;
      }
    }
    // CNPJ match
    if (!matches.find(m => m.stmtId === sid)) {
      for (const r of ativos) {
        if (used.has(r.id)) continue;
        const cnpj = (r.cnpjSacado || "").replace(/\D/g, "");
        if (cnpj && desc.includes(cnpj)) {
          used.add(r.id);
          matches.push({ recId: r.id, dupl: r.dupl, valorFace: r.valor, valorPago: amt, sacado: r.sacado, stmtId: sid, desc, date, conf: "cnpj" });
          break;
        }
      }
    }
  }
  return matches;
}

/* ══════════════════════════════════════════════════════
   EXPRESS APP
   ══════════════════════════════════════════════════════ */
const ihold = new IHold(IHOLD);
const nftSvc = new NFTSvc();
let cachedBal = null, cachedStmts = [], lastRecon = null;

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/health", (req, res) => res.json({
  status: "ok", ts: new Date().toISOString(), v: "4.0",
  ihold: !!ihold.token, nft: nftSvc.ready, nftAddr: nftSvc.addr || null,
  recebiveis: recebiveis.length, nfts: nfts.length,
}));

/* ── iHold endpoints ── */
app.get("/api/balance", async (req, res) => {
  try { const r = await ihold.balance(); cachedBal = r.data; res.json({ ok: true, data: r.data }); }
  catch (e) { res.json({ ok: false, error: e.message, cached: cachedBal }); }
});

app.get("/api/statements", async (req, res) => {
  try {
    const { from, to } = req.query;
    const r = await ihold.statements(from, to);
    cachedStmts = r.data?.data || r.data || [];
    res.json({ ok: true, data: cachedStmts, count: cachedStmts.length });
  } catch (e) { res.json({ ok: false, error: e.message, cached: cachedStmts }); }
});

/* ── Reconciliação ── */
app.post("/api/reconcile", async (req, res) => {
  try {
    let stmts = cachedStmts;
    try {
      const today = new Date().toISOString().split("T")[0];
      const ago = new Date(Date.now() - 30 * 864e5).toISOString().split("T")[0];
      const r = await ihold.statements(ago, today);
      stmts = r.data?.data || r.data || [];
      cachedStmts = stmts;
    } catch (e) { console.warn("Cached stmts:", e.message); }

    const matches = reconcile(recebiveis, stmts);
    if (req.body?.apply !== false && matches.length > 0) {
      for (const m of matches) {
        const r = recebiveis.find(x => x.id === m.recId);
        if (r && r.status === "ativo") {
          r.status = "liquidado"; r.valorPago = m.valorPago; r.dataLiquidacao = m.date;
          r.conciliadoPor = "auto-ihold"; r.statementId = m.stmtId;
        }
      }
      saveJ(DATA_FILE, recebiveis);
    }
    lastRecon = new Date().toISOString();
    res.json({ ok: true, matches: matches.length, details: matches, analyzed: stmts.length, lastRun: lastRecon });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/liquidar", (req, res) => {
  const { ids, valorPago, dataLiquidacao } = req.body;
  if (!ids?.length) return res.status(400).json({ error: "ids required" });
  let n = 0;
  for (const id of ids) {
    const r = recebiveis.find(x => x.id === id);
    if (r && r.status === "ativo") {
      r.status = "liquidado"; r.valorPago = valorPago || r.valor;
      r.dataLiquidacao = dataLiquidacao || new Date().toISOString().split("T")[0];
      r.conciliadoPor = "manual"; n++;
    }
  }
  saveJ(DATA_FILE, recebiveis);
  res.json({ ok: true, liquidados: n });
});

/* ── Recebíveis ── */
app.get("/api/recebiveis", (req, res) => res.json({ ok: true, data: recebiveis }));

app.post("/api/recebiveis", (req, res) => {
  const r = req.body;
  r.id = r.id || "REC-" + String(recebiveis.length + 1).padStart(3, "0");
  r.status = r.status || "ativo";
  r.dataAquisicao = r.dataAquisicao || new Date().toISOString().split("T")[0];
  recebiveis.unshift(r);
  saveJ(DATA_FILE, recebiveis);
  res.json({ ok: true, data: r });
});

app.post("/api/recebiveis/seed", (req, res) => {
  if (recebiveis.length > 0) return res.json({ ok: true, message: "Already seeded", count: recebiveis.length });
  recebiveis = req.body.data || [];
  saveJ(DATA_FILE, recebiveis);
  res.json({ ok: true, seeded: recebiveis.length });
});

/* ── NFT endpoints ── */
app.post("/api/nft/deploy", async (req, res) => {
  try {
    if (nftSvc.ready) return res.json({ ok: true, address: nftSvc.addr, msg: "Already deployed" });
    const addr = await nftSvc.deploy();
    res.json({ ok: true, address: addr, polygonscan: "https://polygonscan.com/address/" + addr });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/nft/mint", async (req, res) => {
  try {
    const { recId, toAddress } = req.body;
    const r = recebiveis.find(x => x.id === recId);
    if (!r) return res.status(404).json({ error: "Not found" });
    if (nfts.find(n => n.recId === recId)) return res.status(400).json({ error: "Already minted", nft: nfts.find(n => n.recId === recId) });

    const to = toAddress || nftSvc.wallet.address;
    const meta = {
      name: "EFIX CR #" + r.dupl,
      description: "Certificado de Recebivel — Duplicata " + r.dupl + " de " + r.cedente + " contra " + r.sacado,
      image: "https://efix-securitizadora-production.up.railway.app/efix-logo.png",
      external_url: "https://efix-securitizadora-production.up.railway.app",
      attributes: [
        { trait_type: "Duplicata", value: r.dupl },
        { trait_type: "Cedente", value: r.cedente },
        { trait_type: "Sacado", value: r.sacado },
        { trait_type: "Valor", value: r.valor, display_type: "number" },
        { trait_type: "Vencimento", value: r.vencto },
        { trait_type: "Operacao", value: r.op },
        { trait_type: "CNPJ Cedente", value: r.cnpjCedente },
        { trait_type: "CNPJ Sacado", value: r.cnpjSacado },
        { trait_type: "Securitizadora", value: "EFIX Securitizadora S.A." },
        { trait_type: "Regulacao", value: "CVM 88 — Ato 23.635/2025" },
      ],
    };

    const result = await nftSvc.mint(to, meta);
    const nftRec = { recId, dupl: r.dupl, tokenId: result.tokenId, txHash: result.txHash, contract: result.contract, block: result.block, owner: to, mintedAt: new Date().toISOString() };
    nfts.push(nftRec);
    saveJ(NFT_FILE, nfts);
    r.nftTokenId = result.tokenId; r.nftTxHash = result.txHash; r.nftContract = result.contract;
    saveJ(DATA_FILE, recebiveis);
    res.json({ ok: true, ...nftRec, polygonscan: "https://polygonscan.com/tx/" + result.txHash });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/api/nft/tokens", (req, res) => res.json({ ok: true, data: nfts }));

app.get("/api/nft/status", async (req, res) => {
  try {
    if (nftSvc.ready) { const s = await nftSvc.status(); res.json({ ok: true, ...s, minted: nfts.length }); }
    else res.json({ ok: true, ready: false, minted: nfts.length });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ── Params ── */
app.get("/api/params", (req, res) => res.json({ ok: true, data: params }));
app.put("/api/params", (req, res) => {
  params = { ...params, ...req.body };
  saveJ(PARAMS_FILE, params);
  res.json({ ok: true, data: params });
});

/* ── Static ── */
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  if (!req.path.startsWith("/api") && !req.path.startsWith("/health"))
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ── Boot ── */
async function boot() {
  console.log("\n  ╔═══════════════════════════════════════╗");
  console.log("  ║  EFIX Securitizadora — Server v4.0    ║");
  console.log("  ╚═══════════════════════════════════════╝\n");
  await ihold.auth().catch(() => {});
  if (ethers) await nftSvc.connect().catch(() => {});
  app.listen(PORT, () => {
    console.log("  → http://localhost:" + PORT);
    console.log("  → Recebíveis:", recebiveis.length, "| NFTs:", nfts.length);
    console.log("  → iHold:", ihold.token ? "OK" : "offline", "| NFT:", nftSvc.ready ? nftSvc.addr : "not deployed\n");
  });
}
boot();
