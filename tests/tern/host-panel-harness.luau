-- SPDX-License-Identifier: MPL-2.0
-- Shipped host renderer at a synthetic HTTP/native lifecycle seam, not desktop proof.
function run(entry)
 local passed=0
 local function copy(v)
  if type(v)~='table' then return v end
  local out={};for k,x in v do out[k]=copy(x) end;return out
 end
 local function fixture(args)
  local f={clock=0,timers={},requests={},handlers={},renders=0,exits=0}
  local encoded,serial={},0
  local function encode(v) serial+=1;local key='json:'..serial;encoded[key]=copy(v);return key end
  local function node(k,p,c) return {k=k,p=p,c=c} end
  local ui={node=node,span=function(t,s)return {t=t,s=s}end,text=function(t)return node('text',{text=t})end,
   col=function(c)return node('col',nil,c)end,row=function(c)return node('row',nil,c)end,lines=function(c)return node('col',nil,c)end,
   badge=function(t,tone)return node('badge',{text=t,tone=tone})end,kv=function(v)return node('kv',{items=v})end,
   section=function(head,c)return node('section',{head=head},c)end,
   progress=function(v,label)return node('progress',{value=v,label=label})end,
   el=function(tag,p,c)local props=copy(p or {});props.tag=tag;return node('el',props,c)end}
  tern={plugin={id='omp-client-bridge',data='/fixture/plugin-data'},ui=ui,now=function()return f.clock end,
   on=function(name,fn)f.handlers[name]=fn end,
   timer=function(ms,fn)
    local item={at=f.clock+ms,fn=fn};table.insert(f.timers,item)
    return {cancel=function()item.cancelled=true end}
   end,
   fs={read=function(path)
    if path=='/fixture/plugin-data/config.json' then return encode({serverControlFile='/fixture/server.json'}) end
    assert(path=='/fixture/server.json','unexpected host file read')
    return encode({url=f.endpoint or 'http://127.0.0.1:9191',token='private-host-fixture-token'})
   end},
   json={null={},encode=encode,decode=function(key)return copy(assert(encoded[key],'bad JSON'))end},
   fetch=function(url,options,callback)
    assert(url:sub(1,21)=='http://127.0.0.1:9191','credential left the host loopback endpoint')
    assert(options.headers.Authorization=='Bearer private-host-fixture-token')
    table.insert(f.requests,{url=url,method=options.method or 'GET',body=options.body and copy(encoded[options.body]),callback=callback})
   end,
   block={define=function(kind,def)if kind=='panel' then f.def=def end end},
  }
  local cx={pane=101,render=function()f.renders+=1 end,exit=function(_,code)assert(code==0);f.exits+=1 end}
  entry();f.cx=cx;f.state=f.def.init(cx,args or {'window-1','panel-1','client-1'},nil)
  function f.tick()
   while #f.timers>0 do local timer=table.remove(f.timers,1);if not timer.cancelled then f.clock=math.max(f.clock,timer.at);timer.fn();return end end
  end
  function f.take(method)
   for i,r in f.requests do if r.method==(method or 'GET') then table.remove(f.requests,i);return r end end
   error('missing host request')
  end
  function f.reply(value)
   local request=f.take();request.callback({status=200,body=encode(value)})
  end
  function f.send(value)f.tick();f.reply({closed=false,snapshot=value})end
  function f.view()return f.def.view(f.state,f.cx)end
  function f.close()f.handlers.pane_exited({pane=101})end
  return f
 end
 local function sample()
  return {owner='window-1',panelId='panel-1',source='Laptop',target='Remote draft',agent='Unbound',connected=true,approvals=0,
   devices={{name='Laptop',platform='darwin',online=true,bound=false}},transfers={{id='transfer-1',name='report.txt',phase='uploading',bytesSent=5,totalBytes=10}}}
 end
 local function active(f)
  local result={}
  local function visit(n)if n.p and n.p.href then result[n.p.key]=n.p.href end;for _,c in n.c or {} do visit(c)end end
  visit(f.view().main);return result
 end
 local function test(name,fn)fn();passed+=1;print('PASS '..name)end
 test('public host snapshots render only through authenticated loopback delivery',function()
  local f=fixture();assert(active(f).paste==nil)
  f.send(sample());assert(f.state.snapshot.transfers[1].bytesSent==5 and active(f).paste~=nil)
  local saved=f.def.save(f.state);assert(next(saved)==nil)
 end)
 test('owner and panel mismatch cannot replace an accepted snapshot',function()
  local f=fixture();f.send(sample())
  local value=sample();value.owner='foreign-window';value.target='wrong';f.send(value)
  assert(f.state.snapshot.target=='Remote draft')
  value=sample();value.panelId='foreign-panel';value.target='wrong';f.send(value)
  assert(f.state.snapshot.target=='Remote draft')
 end)
 test('snapshot values are bounded and cannot inject controls or credentials',function()
  local f=fixture();local value=sample();value.source=string.rep('界',400);value.agent={href='https://evil.invalid'}
  value.token='secret';value.href='https://evil.invalid';value.approvals=math.huge;value.devices={};value.transfers={}
  for i=1,100 do table.insert(value.devices,{name='Device',platform='linux',online='true'});table.insert(value.transfers,{id='x',name='f',bytesSent=-1,totalBytes=0/0})end
  f.send(value);local s=f.state.snapshot
  assert(#s.source<=240 and utf8.len(s.source)~=nil and #s.devices==32 and #s.transfers==20)
  assert(s.token==nil and s.href==nil and s.approvals==0 and not s.devices[1].online)
  for verb,href in active(f) do assert(href=='omp-bridge-panel://window-1/panel-1/'..verb)end
 end)
 test('stalled host requests expire controls without retaining stale snapshot authority',function()
  local f=fixture();f.send(sample());f.tick();f.clock+=15000
  assert(active(f).paste==nil and f.state.snapshot==nil)
  f.reply({closed=false,snapshot=sample()});assert(active(f).paste~=nil)
 end)
 test('a broker close ends only its owned block and stops the timer chain',function()
  local f=fixture();f.tick();f.reply({closed=true});assert(f.exits==1 and f.state.closed)
  local ack=f.take('POST');assert(ack.body.clientId=='client-1' and ack.body.owner=='window-1' and ack.body.panelId=='panel-1')
  f.tick();assert(#f.requests==0 and f.exits==1)
 end)
 test('manual close ignores late network completion and acknowledges the same owner',function()
  local f=fixture();f.tick();local request=f.take();f.close()
  request.callback({status=200,body='late-invalid-response'})
  assert(f.state.snapshot==nil and f.renders==0 and f.exits==0)
  local ack=f.take('POST');assert(ack.body.panelId=='panel-1');f.tick();assert(#f.requests==0)
 end)
 test('foreign endpoint metadata cannot receive the host credential',function()
  local f=fixture();f.endpoint='https://evil.invalid';f.tick()
  assert(#f.requests==0 and active(f).paste==nil)
 end)
 test('invalid launch routing fields never start a host request',function()
  for _,bad in {'','../x','x/y','x?y','x\n',string.rep('x',129)} do
   for _,args in {{bad,'panel-1','client-1'},{'window-1',bad,'client-1'},{'window-1','panel-1',bad}} do
    local f=fixture(args);f.tick();assert(#f.requests==0 and next(active(f))==nil)
   end
  end
 end)
 test('malformed and failed responses cannot authorize display controls',function()
  local f=fixture();f.tick();f.take().callback({status=200,body='bad JSON'});assert(f.state.snapshot==nil)
  f.tick();f.take().callback({status=401,body='private server failure'});assert(active(f).paste==nil)
  f.send(false);assert(f.state.snapshot==nil)
 end)
 print('Host panel regression: '..passed..' cases passed (synthetic SDK boundary only)')
end
