const AK='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';
export default{
  async fetch(req,env){
    const u=new URL(req.url);
    if(u.pathname==='/api/claude'&&req.method==='POST'){
      try{
        const b=await req.json();
        const r=await fetch('https://api.anthropic.com/v1/messages',{
          method:'POST',
          headers:new Headers([
            ['content-type','application/json'],
            ['anthropic-version','2023-06-01'],
            ['x-api-key',AK]
          ]),
          body:JSON.stringify(b)
        });
        const data=await r.json();
        return new Response(JSON.stringify(data),{headers:{'content-type':'application/json','access-control-allow-origin':'*'}});
      }catch(e){return new Response(JSON.stringify({error:{message:e.message}}),{headers:{'content-type':'application/json'}});}
    }
    return env.ASSETS.fetch(req);
  }
}
