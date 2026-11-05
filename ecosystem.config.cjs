module.exports = {
  apps: [{
    name: "agentpay",
    script: "/usr/bin/python3",
    args: "-m uvicorn app.main:app --host 127.0.0.1 --port 3211 --no-proxy-headers",
    cwd: __dirname,
    env: { AGENTPAY_BUYER_KEY: require("fs").readFileSync(require("path").join(__dirname, ".env"),"utf8").match(/AGENTPAY_BUYER_KEY=(.*)/)[1].trim(),
           AGENTPAY_ONCHAIN: "1",
           AGENTPAY_FEE_WALLET: "0xB7e659414eaE35EF277295DE89A5790234e6Ccb7",
           AGENTPAY_DISPUTA: "259200",
           AGENTPAY_PUBLIC_URL: "https://hireaijob.com",
           AGENTPAY_RP_ID: "hireaijob.com",
           AGENTPAY_ORIGIN: "https://hireaijob.com",
           AGENTPAY_DB: require("path").join(__dirname, "data", "agentpay.db") },
  }],
};
