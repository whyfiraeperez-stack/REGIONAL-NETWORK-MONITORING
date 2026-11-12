const ALLOWED = ["DATABASE","DAILY REPORT","OUTAGE ADVISORY","GNOC"];
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
const enc = (s) => b64url(new TextEncoder().encode(s));
function pemBytes(pem){const body=pem.replace(/-----BEGIN PRIVATE KEY-----/g,"").replace(/-----END PRIVATE KEY-----/g,"").replace(/\s/g,"");return Uint8Array.from(atob(body),c=>c.charCodeAt(0));}
async function token(env){
 const service=JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), now=Math.floor(Date.now()/1000);
 const header=enc(JSON.stringify({alg:"RS256",typ:"JWT"}));
 const claim=enc(JSON.stringify({iss:service.client_email,scope:"https://www.googleapis.com/auth/spreadsheets.readonly",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600}));
 const unsigned=header+"."+claim;
 const key=await crypto.subtle.importKey("pkcs8",pemBytes(service.private_key),{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
 const sig=await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,new TextEncoder().encode(unsigned));
 const assertion=unsigned+"."+b64url(sig);
 const response=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion})});
 const payload=await response.json();if(!response.ok)throw new Error(payload.error_description||payload.error||"Google OAuth token request failed");return payload.access_token;
}
function parse(values){const headers=(values[0]||[]).map((h,i)=>String(h||("Column "+(i+1))).trim());const rows=values.slice(1).filter(row=>row.some(v=>String(v??"").trim()!=="")).map(row=>Object.fromEntries(headers.map((h,i)=>[h,row[i]??""])));return {headers,rows,raw:values};}
export async function onRequestGet({request,env}){
 const requested=new URL(request.url).searchParams.get("tab");
 if(requested&&!ALLOWED.includes(requested))return Response.json({error:"Unknown spreadsheet tab."},{status:400});
 if(!env.GOOGLE_SERVICE_ACCOUNT_JSON||!env.GOOGLE_SPREADSHEET_ID)return Response.json({error:"Google Sheets credentials are not configured in Cloudflare secrets."},{status:503});
 try{
  const access=await token(env), names=requested?[requested]:ALLOWED;
  const pairs=await Promise.all(names.map(async name=>{
   const range="'"+name.replace(/'/g,"''")+"'";
   const endpoint="https://sheets.googleapis.com/v4/spreadsheets/"+env.GOOGLE_SPREADSHEET_ID+"/values/"+encodeURIComponent(range)+"?valueRenderOption=FORMATTED_VALUE";
   const response=await fetch(endpoint,{headers:{authorization:"Bearer "+access}});
   const body=await response.json();if(!response.ok)throw new Error(name+": "+(body.error?.message||"Google Sheets API error"));
   return [name,parse(body.values||[])];
  }));
  return Response.json({syncedAt:new Date().toISOString(),sheets:Object.fromEntries(pairs)},{headers:{"cache-control":"no-store"}});
 }catch(error){return Response.json({error:error.message||"Unable to read Google Sheets."},{status:502,headers:{"cache-control":"no-store"}});}
}
