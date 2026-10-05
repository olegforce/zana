import { renderRichResult, type RichResult } from "./rich-result.js";

export type TaskView = {
  title: string;
  channel: string;
  state: string;
  attention: boolean;
  attentionText?: string;
  canvas?: string;
  answer: string;
  answerAt?: number;
  result?: RichResult;
  updated: number;
  observed: number;
  expires: number;
  conversation: string;
};
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
export const sampleTask = (rich = false): TaskView => ({
  title: "Review the release checklist",
  channel: "slack-bridge-demo",
  state: "Ready",
  attention: false,
  answer:
    "The release checklist is ready.\n\n• All three smoke checks passed.\n• The README includes the setup steps.\n• One final review is needed before publishing.\n\nThis is sample content. No agent was started.",
  updated: Date.now(),
  observed: Date.now(),
  expires: Date.now() + 5 * 60000,
  answerAt: Date.now(),
  conversation: "",
  ...(rich ? { result: sampleResult() } : {}),
});

export const sampleResult = (): RichResult => ({
  title: "Release review",
  sections: [
    {
      type: "text",
      title: "Findings",
      text: "The checks passed. Review the example change before publishing. This is synthetic demo data.",
    },
    {
      type: "table",
      title: "Checks",
      columns: ["Check", "Duration (ms)", "Status"],
      rows: [
        ["Launch", "120", "Passed"],
        ["Permissions", "80", "Passed"],
        ["Delivery", "210", "Passed"],
      ],
    },
    {
      type: "chart",
      title: "Check duration",
      unit: "Milliseconds",
      points: [
        { label: "Launch", value: 120 },
        { label: "Permissions", value: 80 },
        { label: "Delivery", value: 210 },
      ],
    },
    {
      type: "code",
      title: "Example",
      language: "typescript",
      text: 'const answer = { state: "ready", checks: 3 };',
    },
    {
      type: "diff",
      title: "Suggested change",
      language: "diff",
      text: "@@ release config @@\n- retries: 0\n+ retries: 2",
    },
    {
      type: "tasks",
      title: "Next steps",
      items: [
        { text: "Run checks", status: "done" },
        { text: "Review the change", status: "running" },
        { text: "Publish after approval", status: "pending" },
      ],
    },
  ],
});

/** No markdown/HTML from agents. Both initial HTML and subsequent updates use text. */
export function renderTask(
  view: TaskView,
  nonce: string,
  demo = false,
  hosted = false,
): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Zana · Task</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#edf1f5;background:#10161c}*{box-sizing:border-box}body{margin:0}main{max-width:780px;margin:auto;padding:32px 24px 24px}header{display:flex;justify-content:space-between;align-items:center;gap:12px}.brand{display:flex;gap:10px;align-items:center;font-weight:700;letter-spacing:-.4px;font-size:21px}.mark{display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:#9aefd0;color:#12352c}.badge{font-size:11px;border:1px solid #465863;padding:3px 9px;border-radius:20px;color:#c2d0d9;white-space:nowrap}.eyebrow{margin:38px 0 8px;color:#9fb0bb;font-size:11px;letter-spacing:1.3px;text-transform:uppercase}h1{font-size:clamp(23px,4vw,32px);line-height:1.2;letter-spacing:-.7px;margin:0 0 22px;overflow-wrap:anywhere}.strip{display:flex;gap:16px;align-items:center;flex-wrap:wrap;color:#aabac5;font-size:12px;margin-bottom:28px}.state{font-weight:650;color:#9aefd0}.dot{display:inline-block;width:7px;height:7px;margin-right:7px;border-radius:50%;background:currentColor}.card{border:1px solid #34424d;border-radius:16px;background:#19232c;padding:24px;box-shadow:0 12px 30px #0002}.card h2{font-size:13px;margin:0 0 18px;color:#a9bbc8;font-weight:500}.answer{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;color:#edf1f5}.answer pre{white-space:pre;overflow:auto;border:1px solid #53687555;background:#0c151c10;padding:16px;border-radius:10px;font:13px/1.6 ui-monospace,monospace}.code-language{display:block;font:11px/1.6 -apple-system,sans-serif;text-transform:uppercase;color:#7e969f;margin-bottom:10px}.time{font-size:11px;color:#a9bbc8;margin:20px 0 0}.attention{border-left:3px solid #f5bf70;padding:10px 16px;margin-bottom:22px;background:#34291a;color:#ffdaa4;font-size:13px}[hidden]{display:none!important}footer{margin-top:24px;font-size:12px;color:#a9bbc8}a{color:#9aefd0;text-underline-offset:4px}a:focus-visible{outline:2px solid #9aefd0;outline-offset:6px}.fine{margin-top:24px;border-top:1px solid #34424d;padding-top:16px;font-size:11px;color:#93a5b3}.disconnected{color:#ffd093}#connection{min-height:20px} @media(max-width:420px){main{padding:22px 18px}.card{padding:18px}.eyebrow{margin-top:30px}} @media(prefers-color-scheme:light){:root{background:#f5f7f8;color:#162c37}.card{background:white;border-color:#d8e2e7;box-shadow:0 12px 30px #122c3707}.answer{color:#162c37}.eyebrow,.strip,.card h2,.time,footer,.fine{color:#516878}.state,a{color:#136b50}.badge{border-color:#c0d1d9;color:#516878}.attention{background:#fff0d9;color:#705022}.fine{border-color:#d8e2e7}.disconnected{color:#8c5a13}}
.result-nav{display:flex;gap:8px;margin-bottom:16px}.result-nav button,.result-table-wrap button{font:inherit;color:inherit;background:transparent;border:0;cursor:pointer}.result-nav button{padding:8px 16px;border-radius:8px;border:1px solid #53687555}.result-nav button[aria-pressed=true]{background:#53687533}.result-nav button:focus-visible,.result-table-wrap button:focus-visible{outline:2px solid #69c8a7;outline-offset:3px}#result>h2{font-size:22px;line-height:1.3;color:inherit;margin-bottom:8px}.result-section{margin-top:26px}.result-section h3{font-size:16px;margin:0 0 12px}.report-note{color:#8199a6;font-size:12px}.result-text{white-space:pre-wrap;overflow-wrap:anywhere}.result-code{overflow:auto;white-space:pre;font:13px/1.6 ui-monospace,monospace;padding:16px;border:1px solid #53687555;border-radius:10px}.diff-added{display:inline;background:#47b68a22;color:#62ba94}.diff-removed{display:inline;background:#db6e6922;color:#d97976}.diff-context{display:inline}.result-table-wrap{overflow:auto}.result-table-wrap table{border-collapse:collapse;width:100%;font-size:13px}.result-table-wrap caption{text-align:left;position:absolute;width:1px;height:1px;overflow:hidden}.result-table-wrap td,.result-table-wrap th{text-align:left;padding:10px;border-bottom:1px solid #53687555;min-width:100px;max-width:230px;overflow-wrap:anywhere}.result-table-wrap button{font-weight:600;text-align:left}.chart-row{display:grid;grid-template-columns:100px minmax(30px,1fr) 60px;gap:12px;align-items:center;margin:12px 0;font-size:12px}.chart-row>span{overflow-wrap:anywhere}.chart-track{height:18px;background:#53687522;border-radius:4px;overflow:hidden}.chart-bar{height:100%;background:#58b79a}.chart-value{text-align:right}.result-board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.result-lane{background:#53687518;border:1px solid #53687544;border-radius:10px;padding:12px}.result-lane h4{font-size:12px;margin:0 0 14px}.result-task{font-size:13px;overflow-wrap:anywhere;padding:12px;background:#53687522;border-radius:6px}@media(prefers-color-scheme:light){.report-note{color:#516878}.diff-added{color:#136b50}.diff-removed{color:#a33330}}@media(max-width:640px){.result-board{grid-template-columns:1fr}.chart-row{grid-template-columns:80px minmax(30px,1fr) 50px;gap:8px}}
.state.unavailable{color:#8199a6}@media(prefers-color-scheme:light){.state.unavailable{color:#516878}}
</style></head><body><main>
<header><div class="brand"><span class="mark" aria-hidden="true">z</span>Zana</div><span class="badge">${demo ? "Demo preview" : "Read-only task"}</span></header>
<p class="eyebrow" id="channel">#${escape(view.channel)}</p><h1 id="title">${escape(view.title)}</h1>
<div class="strip"><span class="state"><span class="dot" aria-hidden="true"></span><span id="state">${escape(view.state)}</span></span><span>Runs on your Zana machine</span></div>
<div class="attention" id="attention" ${view.attention ? "" : "hidden"}>${escape(view.attentionText || "Your input is needed. Open Zana on your computer to review the permission or question.")}</div>
<nav class="result-nav" id="result-nav" aria-label="Task view" hidden><button type="button" id="summary-tab" aria-pressed="true">Summary</button><button type="button" id="report-tab" aria-pressed="false">Report</button></nav>
<section class="card" id="summary-panel" aria-labelledby="answer-heading"><h2 id="answer-heading">Answer shared to Slack</h2><p class="answer" id="answer">${escape(view.answer || "No answer has been shared yet. Updates appear here after Slack confirms delivery.")}</p><p class="time" id="answer-time">${view.answerAt ? "Shared " + escape(new Date(view.answerAt).toLocaleString("en-GB", { timeZone: "UTC" })) + " UTC" : "Waiting for a confirmed answer"}</p></section>
<section class="card" id="result" aria-label="Shared report" hidden></section><template id="result-data">${escape(JSON.stringify(view.result ?? null))}</template><a id="canvas" href="${escape(view.canvas || "")}" target="_blank" rel="noopener noreferrer" ${view.canvas ? "" : "hidden"}>Open Canvas snapshot ↗</a>
<footer><p id="connection" role="status">${demo ? "Sample task · no live data" : "Connected · refreshing every 10 seconds"}</p><a id="conversation" href="${escape(view.conversation)}" target="_blank" rel="noopener noreferrer" ${view.conversation ? "" : "hidden"}>Open conversation in Slack ↗</a><p class="fine">${demo ? "This preview shows the page design. Enable the custom task panel in Zana for Slack to use it with your connected account." : "Only answers and reports shared to Slack appear here. Use Zana Home in Slack to start or stop agents. This private view expires after five minutes; reopen its card to continue."}</p></footer>
</main>${`<script nonce="${nonce}">
(()=>{
const node=(id)=>document.getElementById(id);
const drawResult=${renderRichResult.toString()};
let reportOpen=false,resultSignature;
const switchPanel=()=>{node('summary-panel').hidden=reportOpen;node('result').hidden=!reportOpen;node('summary-tab').setAttribute('aria-pressed',String(!reportOpen));node('report-tab').setAttribute('aria-pressed',String(reportOpen));};
const updateResult=(result)=>{const signature=JSON.stringify(result??null);if(signature!==resultSignature){drawResult(node('result'),result);resultSignature=signature;}node('result-nav').hidden=!result;if(!result)reportOpen=false;switchPanel();};
node('summary-tab').onclick=()=>{reportOpen=false;switchPanel();};node('report-tab').onclick=()=>{reportOpen=true;switchPanel();};
const initial=node('result-data');updateResult(JSON.parse(initial.content.textContent));initial.remove();
if(${demo})return;
const endpoint=new URL(location.href), hosted=${hosted}, token=hosted ? new URLSearchParams(location.hash.slice(1)).get("key") : null;
endpoint.hash="";
if(hosted)endpoint.pathname=endpoint.pathname.replace("/view/","/data/");
let deadline=${view.expires};
let timer, pending, stopped=false;
const renderAnswer=(text)=>{const root=node('answer');root.replaceChildren();const parts=text.split(/\x60\x60\x60([^\\n]*)\\n([\\s\\S]*?)\x60\x60\x60/g);for(let i=0;i<parts.length;i+=3){root.append(document.createTextNode(parts[i]));if(i+2<parts.length){const block=document.createElement('pre'),label=document.createElement('span'),code=document.createElement('code');label.className='code-language';label.textContent=parts[i+1].trim()||'Code';code.textContent=parts[i+2].replace(/\\n$/,'');block.append(label,code);root.append(block);}}};
renderAnswer(node('answer').textContent);

const end=(message,clear=false)=>{stopped=true;clearTimeout(timer);pending?.abort();node('connection').textContent=message;node('connection').className='disconnected';if(clear){node('answer').textContent='Reopen the task card in Slack to request access.';node('title').textContent='Task view closed';node('channel').textContent='Zana';node('state').textContent='Unavailable';node('state').parentElement.classList.add('unavailable');node('attention').hidden=true;node('conversation').hidden=true;node('conversation').href='';node('canvas').hidden=true;node('canvas').href='';node('answer-time').textContent='';updateResult(undefined);}};
let expiry;
const arm=()=>{clearTimeout(expiry);expiry=setTimeout(()=>end('Access expired · reopen this task in Slack',true),Math.max(0,deadline-Date.now()));};arm();
const checkExpiry=()=>{if(!stopped&&Date.now()>=deadline)end('Access expired · reopen this task in Slack',true);};
document.addEventListener('visibilitychange',checkExpiry);
async function refresh(){checkExpiry();if(stopped)return;pending=new AbortController();const timeout=setTimeout(()=>pending?.abort(),7000);try{const r=await fetch(endpoint.href,{headers:{Accept:'application/json',...(hosted?{Authorization:'Bearer '+token}:{})},credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:pending.signal});if(r.status===403||r.status===410){end('Access ended · reopen this task in Slack',true);return;}if(!r.ok)throw new Error();const v=await r.json();if(stopped)return;deadline=Math.min(deadline,v.expires);arm();node('canvas').hidden=!v.canvas;node('canvas').href=v.canvas||'';node('attention').textContent=v.attentionText||'Your input is needed. Open Zana on your computer to review the permission or question.';node('conversation').hidden=!v.conversation;node('conversation').href=v.conversation||'';node('title').textContent=v.title;node('channel').textContent='#'+v.channel;node('state').textContent=v.state;node('attention').hidden=!v.attention;updateResult(v.result);renderAnswer(v.answer||'No answer has been shared yet. Updates appear here after Slack confirms delivery.');node('answer-time').textContent=v.answerAt?'Shared '+new Date(v.answerAt).toLocaleString():'Waiting for a confirmed answer';node('connection').textContent='Updated '+new Date(v.observed).toLocaleTimeString()+' · refreshing every 10 seconds';node('connection').className='';}catch{if(!stopped){node('connection').textContent='Connection lost · showing the last snapshot. Keep Zana awake.';node('connection').className='disconnected';}}finally{clearTimeout(timeout);pending=undefined;}if(!stopped)timer=setTimeout(refresh,10000);}
timer=setTimeout(refresh,hosted?0:10000);window.addEventListener('pagehide',()=>{document.removeEventListener('visibilitychange',checkExpiry);stopped=true;clearTimeout(timer);clearTimeout(expiry);pending?.abort();},{once:true});
})();</script>`}</body></html>`;
}
