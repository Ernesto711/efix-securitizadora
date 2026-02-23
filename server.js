const express = require("express");
const crypto = require("crypto");
const path = require("path");

const PORT = parseInt(process.env.PORT || "3000");
const ADMIN_KEY = process.env.ADMIN_KEY || "efixdi-admin-2026";
const START = Date.now();

let blockNumber = 73_245_891;
const OP = "0x7C54Dccd6fC5DB73b34f32aCA4d1631E054c7537";
const mock = { tvl_brl: "2412850.000000000000000000", tvl_usd: "414909.42", efix_total_supply: "2412850.000000000000000000", brl_usd_rate: "0.172014", brl_usd_updated: new Date().toISOString(), vault_paused: false, bridge_paused: false, current_block: blockNumber };
const opBal = { matic: "12.847", usdc: "4850.32" };
const svc = { hausbank: { authenticated: true, tokenExpiry: new Date(Date.now()+3600000).toISOString(), circuit: { name: "hausbank", state: "CLOSED", failures: 0 } }, deposits: { queue_length: 0, processing: false, total_processed: 14, by_status: { confirmed: 12, failed: 1 } }, withdrawals: { last_scanned_block: blockNumber-50, pending_count: 0, total: 3, by_status: { completed: 3 }, recent: [] }, keeper: { last_check: new Date().toISOString(), risky_positions: 0 }, oracleV1: { last_update: new Date().toISOString(), last_price: 0.172014, errors: 0, interval: "4h" }, poller: { running: true, initialized: true, knownTransactions: 47, pollIntervalMs: 30000 } };
const events = [
  { ts: new Date(Date.now()-86400000).toISOString(), type: "deposit_confirmed", amount: 50000, txHash: "0x7a3f...e821", user: OP },
  { ts: new Date(Date.now()-43200000).toISOString(), type: "withdrawal_completed", amount: 30000 },
  { ts: new Date(Date.now()-21600000).toISOString(), type: "deposit_confirmed", amount: 280000, txHash: "0x2e7f...d501" },
  { ts: new Date(Date.now()-7200000).toISOString(), type: "oracle_v1_updated", price: 0.172014 },
  { ts: new Date(Date.now()-1800000).toISOString(), type: "deposit_confirmed", amount: 95000, txHash: "0x9f2c...b443" }
];
const processed = new Map([["PIX-48291",{status:"confirmed",txHash:"0x9f2c8a1d4e5b6c7d",ts:Date.now()-1800000,user:OP,amount:95000}]]);
const counters = { deposits_confirmed: 12, webhooks_received: 18, http_ok: 0 };

const app = express();
app.use(express.json());
app.use((req,res,next)=>{res.header("Access-Control-Allow-Origin","*");res.header("Access-Control-Allow-Methods","GET,POST,OPTIONS");res.header("Access-Control-Allow-Headers","Content-Type,Authorization,X-Admin-Key");if(req.method==="OPTIONS")return res.sendStatus(200);next()});
const auth=(req,res,next)=>{const k=req.headers["x-admin-key"]||req.query.key;if(k!==ADMIN_KEY)return res.status(401).json({error:"Unauthorized"});next()};

// ── API ──
app.get("/health",(req,res)=>{blockNumber+=Math.floor(Math.random()*3)+1;mock.current_block=blockNumber;res.json({status:"ok",ts:new Date().toISOString(),block:blockNumber,uptime:Math.floor((Date.now()-START)/1000),mode:"TEST",services:{blockchain:"connected",hausbank:"authenticated",deposits:"idle",withdrawals:"listening",keeper:"active",oracleV1:"active",autoMint:"polling"}})});

app.post("/api/pix/qrcode",(req,res)=>{const{amount}=req.body;if(!amount||isNaN(amount)||Number(amount)<1)return res.status(400).json({error:"Invalid amount"});const uuid=crypto.randomUUID();const emv="00020126580014br.gov.bcb.pix0136"+uuid+"5204000053039865406"+Number(amount).toFixed(2)+"5802BR5925EFIX SECURITIZADORA SA6014RIO DE JANEIRO62070503***6304";res.json({success:true,qrcode:{uuid,conciliationId:"CONC-"+Date.now(),emv,amount:Number(amount).toFixed(2),imageUrl:"https://api.qrserver.com/v1/create-qr-code/?size=300x300&data="+encodeURIComponent(emv),copyPaste:emv}})});

app.get("/api/deposit/status/:wallet",(req,res)=>{const w=req.params.wallet.toLowerCase();const results=[];for(const[id,info]of processed.entries()){if((info.user||"").toLowerCase()===w)results.push({e2eId:id,...info})}const latest=results.sort((a,b)=>(b.ts||0)-(a.ts||0))[0];if(!latest)return res.json({found:false,status:"waiting"});res.json({found:true,status:latest.status,txHash:latest.txHash,e2eId:latest.e2eId,amount:latest.amount,ts:latest.ts})});

app.get("/api/status",auth,(req,res)=>{blockNumber++;mock.current_block=blockNumber;const v=2412850+Math.floor(Math.random()*5000);mock.tvl_brl=v+".000000000000000000";mock.tvl_usd=(v*0.172014).toFixed(2);mock.efix_total_supply=v+".000000000000000000";res.json({protocol:mock,operator:{address:OP,balances:opBal},services:{hausbank:svc.hausbank,deposits:svc.deposits,withdrawals:svc.withdrawals,keeper:svc.keeper,oracleV1Keeper:svc.oracleV1},metrics:{uptime_seconds:Math.floor((Date.now()-START)/1000),counters,gauges:{last_block:blockNumber,tvl_brl:v}}})});

app.get("/api/metrics",auth,(req,res)=>{res.json({uptime_seconds:Math.floor((Date.now()-START)/1000),counters,gauges:{last_block:blockNumber}})});
app.get("/api/events",auth,(req,res)=>{const n=parseInt(req.query.n||"50");res.json(events.slice(-n).reverse())});
app.get("/api/deposits",auth,(req,res)=>{res.json(svc.deposits)});
app.get("/api/withdrawals",auth,(req,res)=>{res.json(svc.withdrawals)});
app.get("/api/poller",auth,(req,res)=>{res.json(svc.poller)});
app.get("/api/position/:address",auth,(req,res)=>{if(req.params.address.toLowerCase()===OP.toLowerCase())return res.json({principal_brl:"550000.0",efix_balance:"550000.0",borrowed_usdc:"68750.0",health_factor:"1.4900",current_apy:"25.60%",leverage_level:2});res.status(404).json({error:"No position"})});

app.post("/api/admin/deposit",auth,(req,res)=>{const{userAddress,amount}=req.body;if(!userAddress||!amount)return res.status(400).json({error:"userAddress and amount required"});const txHash="0x"+crypto.randomBytes(32).toString("hex");const e2eId="MANUAL-"+Date.now();processed.set(e2eId,{status:"confirmed",txHash,ts:Date.now(),user:userAddress,amount:Number(amount)});events.push({ts:new Date().toISOString(),type:"deposit_confirmed",endToEndId:e2eId,amount:Number(amount),txHash,user:userAddress});counters.deposits_confirmed++;console.log("MINT "+amount+" efixDI -> "+userAddress.slice(0,10)+"...");res.json({status:"queued",txHash,endToEndId:e2eId})});

app.get("/api/admin/test-auth",auth,(req,res)=>{res.json({success:true,status:svc.hausbank})});
app.post("/webhook/pix",(req,res)=>{console.log("WEBHOOK:",JSON.stringify(req.body).slice(0,200));const e2eId=(req.body.data?.end_to_end_id)||"WH-"+Date.now();const txHash="0x"+crypto.randomBytes(32).toString("hex");processed.set(e2eId,{status:"confirmed",txHash,ts:Date.now(),user:req.body.data?.metadata?.wallet||OP,amount:Number(req.body.data?.amount||0)});events.push({ts:new Date().toISOString(),type:"deposit_confirmed",amount:Number(req.body.data?.amount||0),txHash});res.json({status:"accepted",txHash})});

// ── Serve frontend ──
app.use(express.static(path.join(__dirname, "public")));
app.get("*",(req,res)=>{if(!req.path.startsWith("/api")&&!req.path.startsWith("/health")&&!req.path.startsWith("/webhook")){res.sendFile(path.join(__dirname,"public","index.html"))}});

app.listen(PORT,()=>{console.log(`\n  EFIX Securitizadora — v1.0\n  http://localhost:${PORT}\n  API + Frontend on same server\n  Mode: TEST\n`)});
// v2 deploy
