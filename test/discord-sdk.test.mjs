import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { ChannelType, Client, ClientUser, Events } from 'discord.js'
import { startDiscord } from '../dist/channels/discord.js'

test('discord.js bridges a Gateway DM to Prism and posts and edits the same task via Discord REST', async t => {
  const bot={id:'100000000000000111',username:'prism',discriminator:'0000',avatar:null,bot:true}
  const user={id:'100000000000000222',username:'user',discriminator:'0000',avatar:null,bot:false}
  const channel='100000000000000333', incomingId='100000000000000444', outgoingId='100000000000000555'
  const token='discord-fixture', calls=[]
  let adapter, sdk
  const received=Promise.withResolvers()
  const mounted=Promise.withResolvers()
  const controller=new AbortController()
  const server=createServer(async(req,res)=>{
    let text=''; for await(const part of req)text+=part
    const body=text && JSON.parse(text)
    calls.push({route:req.method+' '+req.url,body,token:req.headers.authorization})
    res.setHeader('content-type','application/json')
    if(req.method==='GET') res.end(JSON.stringify({id:channel,type:ChannelType.DM,recipients:[user]}))
    else res.end(JSON.stringify({id:outgoingId,channel_id:channel,channel_type:1,type:0,author:bot,content:body.content,
      timestamp:new Date().toISOString(),components:body.components,mentions:[],mention_roles:[],attachments:[],embeds:[]}))
  })
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  t.after(()=>new Promise(done=>server.close(done)))
  t.mock.method(Client.prototype,'login',async function(value) {
    assert.equal(value,token)
    sdk=this
    this.user=new ClientUser(this,bot)
    this.users.cache.set(bot.id,this.user)
    this.rest.options.api='http://127.0.0.1:'+server.address().port
    this.rest.setToken(value)
    this.emit(Events.ClientReady,this)
    return value
  })
  process.env.PRISM_TEST_DISCORD=token
  const running=startDiscord({tokenEnv:'PRISM_TEST_DISCORD',allowedUserIds:[user.id]},{
    signal:controller.signal, access:()=>target=>target.user===user.id,
    mount:transport=>{adapter=transport;mounted.resolve();return {receive:async input=>received.resolve(input)}},warn:()=>{},
  })
  t.after(async()=>{controller.abort();await running;delete process.env.PRISM_TEST_DISCORD})
  await Promise.race([mounted.promise,running])
  sdk.actions.MessageCreate.handle({id:incomingId,channel_id:channel,channel_type:ChannelType.DM,author:user,type:0,
    timestamp:new Date().toISOString(),content:'hello',mentions:[],mention_roles:[],attachments:[],embeds:[]})
  assert.deepEqual(await received.promise,{id:incomingId,user:user.id,chat:channel,text:'hello',username:user.username})
  const target={chat:channel,user:user.id}, reply={text:'Task',inspectTask:'test',deliveryId:'a'.repeat(64)}
  assert.equal(await adapter.send(target,reply),outgoingId)
  assert.equal(await adapter.edit(target,outgoingId,{...reply,text:'Complete'}),outgoingId)
  const create=calls.find(c=>c.route==='POST /v10/channels/'+channel+'/messages')
  const edit=calls.find(c=>c.route==='PATCH /v10/channels/'+channel+'/messages/'+outgoingId)
  assert.equal(create.token,'Bot '+token)
  assert.equal(create.body.enforce_nonce,true)
  assert.equal(create.body.nonce,'a'.repeat(24))
  assert.deepEqual(create.body.allowed_mentions,{parse:[]})
  assert.equal(edit.body.content,'Complete')
  assert.equal(edit.body.components[0].components[0].custom_id,'prism:inspect:test')
  await assert.rejects(adapter.send({...target,user:'other'},reply))
})
