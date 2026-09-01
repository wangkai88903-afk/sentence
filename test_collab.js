// 验证协作字段（评论/标注/高亮）在云端合并时的「按 id 去重并集」与「双向保留」
const BASE = "http://127.0.0.1:8903";
const post = (p, body) => fetch(BASE + p, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) }).then(r=>r.json());
const photo = "data:image/png;base64,iVBORw0KGgoAAAA";
let pass=0, fail=0;
function chk(name, cond){ if(cond){ pass++; console.log("  ✓ "+name); } else { fail++; console.log("  ✗ "+name); } }

(async () => {
  const fam = await post("/api/family/create", {});
  const fid = fam.familyId, fk = fam.familyKey;
  console.log("家庭云:", fid+"-"+fk);

  // 1) 家长端 push：带评论 + 照片标注
  await post("/api/sync/push", { familyId:fid, familyKey:fk, byUser:"dad", payload:{
    accounts:{ dad:{user:"dad",pass:"h1",role:"parent"}, kid:{user:"kid",pass:"h1",role:"child"} },
    checkins:{ "7A-01": { ts:100, photo,
      comments:[{id:"dad:c1",by:"dad",role:"parent",text:"写得不错，继续加油",ts:100}],
      annotations:[{id:"dad:a1",by:"dad",role:"parent",target:"photo",type:"text",text:"注意这里",x:0.5,y:0.5,color:"#ef4444",ts:100}] } },
    extra:[], removed:[] } });

  // 2) 孩子端 pull：应能看到家长的评论和标注
  let r = await post("/api/sync/pull", { familyId:fid, familyKey:fk });
  let rec = r.checkins["7A-01"];
  console.log("孩子 pull 后:");
  chk("评论数=1", rec.comments && rec.comments.length===1);
  chk("标注数=1", rec.annotations && rec.annotations.length===1);
  chk("评论作者=dad", rec.comments[0].by==="dad");

  // 3) 孩子端 push：只带高亮（本地没有家长评论/标注，模拟独立新增）
  await post("/api/sync/push", { familyId:fid, familyKey:fk, byUser:"kid", payload:{
    accounts:{ dad:{user:"dad",pass:"h1",role:"parent"}, kid:{user:"kid",pass:"h1",role:"child"} },
    checkins:{ "7A-01": { ts:200, photo,
      highlights:[{id:"kid:h1",by:"kid",role:"child",text:"定语",ts:200}] } },
    extra:[], removed:[] } });

  // 4) 家长端 pull：应得到并集（评论+标注+高亮都在）
  r = await post("/api/sync/pull", { familyId:fid, familyKey:fk });
  rec = r.checkins["7A-01"];
  console.log("家长 pull 后（并集）:");
  chk("评论仍保留(=1)", rec.comments && rec.comments.length===1 && rec.comments[0].by==="dad");
  chk("标注仍保留(=1)", rec.annotations && rec.annotations.length===1);
  chk("高亮已合并(=1)", rec.highlights && rec.highlights.length===1 && rec.highlights[0].by==="kid");
  chk("核心字段 photo 未丢", !!rec.photo);

  // 5) 孩子端重复 push 同一条高亮 id：应去重（高亮数不增）
  await post("/api/sync/push", { familyId:fid, familyKey:fk, byUser:"kid", payload:{
    accounts:{ dad:{user:"dad",pass:"h1",role:"parent"}, kid:{user:"kid",pass:"h1",role:"child"} },
    checkins:{ "7A-01": { ts:300, photo, highlights:[{id:"kid:h1",by:"kid",role:"child",text:"定语",ts:300}] } },
    extra:[], removed:[] } });
  r = await post("/api/sync/pull", { familyId:fid, familyKey:fk });
  rec = r.checkins["7A-01"];
  chk("重复高亮已去重(=1)", rec.highlights && rec.highlights.length===1);

  console.log("\n结果: "+pass+" 通过, "+fail+" 失败");
  process.exit(fail? 1 : 0);
})().catch(e=>{ console.error("异常:", e.message); process.exit(2); });
