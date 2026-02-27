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
