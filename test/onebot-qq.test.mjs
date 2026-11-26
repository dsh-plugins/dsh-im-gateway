import assert from 'node:assert/strict'
import { createHmac, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { startOneBot } from '../dist/channels/onebot.js'
import { startQQ } from '../dist/channels/qq.js'
import { GatewayState } from '../dist/state.js'

const realFetch = globalThis.fetch
async function listener(t, handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server,'listening')
  t.after(() => new Promise(done => server.close(done)))
  return 'http://127.0.0.1:' + server.address().port
}

async function setup(t, start, config) {
  let transfer, pairCandidate
  const endpoints = new Map(), accepted = []
  const state = new GatewayState(':memory:')
  t.after(() => state.close())
  start(config, {
    signal:new AbortController().signal,state,directory:'',warn:()=>{},
    access:() => target => config.allowedUserIds.includes(target.user),
    mount:adapter => {transfer=adapter; return {receive:async input=>{
      if (adapter.permits(input)) accepted.push(input)
      else pairCandidate=input
    }}},
    webhook:(path,handle)=>endpoints.set(path,handle),
  })
  const base = await listener(t,(req,res)=>endpoints.get(req.url)(req,res))
  return {
    accepted,adapter:transfer,pairCandidate:()=>pairCandidate,
    post:(path,headers,body)=>realFetch(base+path,{method:'POST',headers:{'content-type':'application/json',...headers},body}),
  }
}

test('OneBot v11 verifies reverse HTTP events, isolates friend DMs and sends text segments to the configured bot', async t => {
  const calls=[]
  const apiBase=await listener(t,async(req,res)=>{
    let data=''; for await(const part of req)data+=part
    assert.equal(req.headers.authorization,'Bearer api-secret')
    calls.push([req.url,JSON.parse(data)])
    res.setHeader('content-type','application/json')
    res.end(JSON.stringify({status:'ok',retcode:0,data:req.url==='/get_login_info'?{user_id:123}:{message_id:-41}}))
  })
  const token='PRISM_TEST_ONE_API', secret='PRISM_TEST_ONE_SIG'
  process.env[token]='api-secret';process.env[secret]='sig-secret'
  t.after(()=>{delete process.env[token];delete process.env[secret]})
  const fixture=await setup(t,startOneBot,{selfId:'123',apiBase,allowedUserIds:['456'],accessTokenEnv:token,eventSecretEnv:secret})
  const event={self_id:123,post_type:'message',message_type:'private',sub_type:'friend',message_id:18,user_id:456,
    message:[{type:'text',data:{text:'hello'}},{type:'image',data:{file:'local'}},{type:'text',data:{text:'!'}}]}
  function post(change={},bad=false) {
    const body=JSON.stringify({...event,...change},null,2)
    const signature=createHmac('sha1',bad?'other':'sig-secret').update(body).digest('hex')
    return fixture.post('/prism/im/onebot',{'x-self-id':'123','x-signature':'sha1='+signature},body)
  }
  assert.equal((await post({},true)).status,401)
  assert.equal((await post({self_id:789})).status,403)
  assert.equal((await post({message_type:'group'})).status,200)
  assert.equal((await post({sender:{user_id:789}})).status,200)
  assert.equal((await post()).status,200)
  assert.deepEqual(fixture.accepted,[{chat:'456',user:'456',id:'18',text:'hello!'}])
  await post({user_id:789,message:'/pair 123'})
  assert.equal(fixture.pairCandidate().user,'789')
  const to={chat:'456',user:'456'}, reply={text:'[CQ:at,qq=all]',inspectTask:'task'}
  assert.equal(await fixture.adapter.send(to,reply),'-41')
  assert.equal(await fixture.adapter.edit(to,'-40',reply),'-41')
  assert.deepEqual(calls.map(([name])=>name),['/get_login_info','/send_private_msg','/send_private_msg'])
  assert.deepEqual(calls[1][1],{user_id:456,message:[{type:'text',data:{text:'[CQ:at,qq=all]\n/inspect task'}}]})
  await assert.rejects(fixture.adapter.send({...to,chat:'789'},reply))
})

test('official QQ signs validation challenges, checks dispatches and preserves passive sequence across delivery retries', async t => {
  const secret='QQ_TEST_SECRET', appSecret='1234567890123456'
  process.env[secret]=appSecret
  t.after(()=>{delete process.env[secret];globalThis.fetch=realFetch})
  const key=createPrivateKey({format:'der',type:'pkcs8',key:Buffer.concat([
    Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(appSecret.repeat(2)),
  ])})
  const sent=[],times=new Map()
  globalThis.fetch=async(url,options)=>{
    assert.equal(new URL(url).origin,'https://api.bot.qq.com')
    const request=JSON.parse(options.body)
    if (new URL(url).pathname==='/app/getAppAccessToken') {
      assert.deepEqual(request,{appId:'123',clientSecret:appSecret})
      return Response.json({access_token:'cached',expires_in:'7200'})
    }
    assert.equal(new URL(url).pathname,'/v2/users/a123/messages')
    assert.equal(options.headers.authorization,'QQBot cached')
    sent.push(request)
    if (request.msg_id) {
      const attempts=(times.get(request.msg_seq)??0)+1
      times.set(request.msg_seq,attempts)
      if (attempts>1) return Response.json({code:40054005},{status:400})
    }
    return Response.json({id:'sent-'+sent.length})
  }
  const fixture=await setup(t,startQQ,{appId:'123',appSecretEnv:secret,allowedUserIds:['a123']})
  function post(event,bad=false) {
    const body=JSON.stringify(event)
    const ts=String(Math.floor(Date.now()/1000))
    const signature=sign(null,Buffer.from(ts+body),key).toString('hex')
    return fixture.post('/prism/im/qq',{'x-signature-timestamp':ts,'x-signature-ed25519':bad?'ff'.repeat(64):signature},body)
  }
  const validation={op:13,d:{plain_token:'challenge',event_ts:'123456'}}
  assert.equal((await post(validation,true)).status,401)
  const unsigned = event => fixture.post('/prism/im/qq',{'x-bot-appid':'123'},JSON.stringify(event))
  const challenge=await unsigned(validation)
  assert.equal(challenge.status,200)
  assert.deepEqual(await challenge.json(),await(await post(validation)).json())
  assert.equal((await unsigned({...validation,op:0})).status,401)
  assert.equal((await unsigned({op:13,d:{...validation.d,plain_token:'{"op":0}'}})).status,401)
  const proof=await(await post(validation)).json()
  assert.equal(proof.plain_token,'challenge')
  assert(verify(null,Buffer.from('123456challenge'),createPublicKey(key),Buffer.from(proof.signature,'hex')))
  assert.deepEqual(await(await post({op:1,d:78})).json(),{op:11,d:78})
  const event={op:0,t:'C2C_MESSAGE_CREATE',d:{id:'msg-1',timestamp:new Date().toISOString(),author:{user_openid:'a123'},content:'hello'}}
  await post({...event,t:'GROUP_AT_MESSAGE_CREATE'})
  assert.deepEqual(await(await post(event)).json(),{op:12,d:0})
  assert.deepEqual(fixture.accepted,[{chat:'a123',user:'a123',id:'msg-1',text:'hello'}])
  const target={chat:'a123',user:'a123'}
  const reply={text:'from L1',deliveryId:'delivery-1'}
  assert.equal(await fixture.adapter.send(target,reply),'sent-1')
  assert.equal(await fixture.adapter.send(target,reply),'reply:msg-1:1')
  for(let i=2;i<=5;i++)await fixture.adapter.edit(target,'old',{...reply,deliveryId:'delivery-'+i})
  assert.deepEqual(sent.map(x=>[x.msg_id,x.msg_seq]),[['msg-1',1],['msg-1',1],['msg-1',2],['msg-1',3],['msg-1',4],[undefined,undefined]])
  await post({op:0,t:'C2C_MSG_REJECT',d:{openid:'a123'}})
  await assert.rejects(fixture.adapter.send(target,{text:'blocked'}),/disabled/)
  await post({op:0,t:'C2C_MSG_RECEIVE',d:{openid:'a123'}})
  await fixture.adapter.send(target,{text:'available'})
  await assert.rejects(fixture.adapter.send({chat:'someone-else',user:'a123'},reply))
})
