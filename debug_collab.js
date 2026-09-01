const BASE = "http://127.0.0.1:8903";
const post = (p, b) => fetch(BASE + p, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(b) }).then(r=>r.json());
(async () => {
  const fam = await post("/api/family/create", {});
  console.log("create:", fam.ok, fam.familyId, fam.familyKey);
  const fid = fam.familyId, fk = fam.familyKey;
  const photo = "data:image/png;base64,iVBORw0KGgoAAAA";
  const r1 = await post("/api/sync/push", { familyId:fid, familyKey:fk, byUser:"dad", payload:{
    accounts:{ dad:{user:"dad",pass:"h1",role:"parent"}, kid:{user:"kid",pass:"h1",role:"child"} },
    checkins:{ "7A-01": { ts:100, photo,
      comments:[{id:"dad:c1",by:"dad",role:"parent",text:"x",ts:100}],
      annotations:[{id:"dad:a1",by:"dad",role:"parent",target:"photo",type:"text",text:"y",x:0.5,y:0.5,color:"#ef4444",ts:100}] } },
    extra:[], removed:[] } });
  console.log("push1:", JSON.stringify(r1));
  const r2 = await post("/api/sync/pull", { familyId:fid, familyKey:fk });
  console.log("pull1 keys:", Object.keys(r2.checkins||{}));
  console.log("pull1 7A-01:", JSON.stringify(r2.checkins && r2.checkins["7A-01"]));
  const r3 = await post("/api/sync/push", { familyId:fid, familyKey:fk, byUser:"kid", payload:{
    accounts:{ dad:{user:"dad",pass:"h1",role:"parent"}, kid:{user:"kid",pass:"h1",role:"child"} },
    checkins:{ "7A-01": { ts:200, photo, highlights:[{id:"kid:h1",by:"kid",role:"child",text:"定语",ts:200}] } },
    extra:[], removed:[] } });
  console.log("push2:", JSON.stringify(r3));
  const r4 = await post("/api/sync/pull", { familyId:fid, familyKey:fk });
  const rec = r4.checkins && r4.checkins["7A-01"];
  console.log("pull2 comments:", rec && rec.comments && rec.comments.length, "annotations:", rec && rec.annotations && rec.annotations.length, "highlights:", rec && rec.highlights && rec.highlights.length);
})().catch(e=>{ console.error("ERR:", e.message); });
