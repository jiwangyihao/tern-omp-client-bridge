-- SPDX-License-Identifier: MPL-2.0
-- Shipped host renderer at a synthetic HTTP/native lifecycle seam, not desktop proof.
function run(entry)
 local passed=0
 local function copy(v)
  if type(v)~='table' then return v end
  local out={};for k,x in v do out[k]=copy(x) end;return out
 end
 local function fixture(args,saved)
  local f={clock=0,timers={},requests={},handlers={},renders=0,exits=0}
  local encoded,serial={},0
  local function encode(v) serial+=1;local key='json:'..serial;encoded[key]=copy(v);return key end
  local function node(k,p,c) return {k=k,p=p,c=c} end
  local ui={node=node,span=function(t,s)return {t=t,s=s}end,text=function(t)return node('text',{text=t})end,
   col=function(c)return node('col',nil,c)end,row=function(c)return node('row',nil,c)end,lines=function(c)return node('col',nil,c)end,
   badge=function(t,tone)return node('badge',{text=t,tone=tone})end,
   section=function(head,children)return node('section',{head=head},children)end,
   progress=function(v,label)return node('progress',{value=v,label=label})end}
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
  entry();f.cx=cx;f.state=f.def.init(cx,args or {'window-1','panel-1','client-1'},saved)
  function f.tick()
   while #f.timers>0 do
    local earliest=1;for i,item in f.timers do if item.at<f.timers[earliest].at then earliest=i end end
    local timer=table.remove(f.timers,earliest)
    if not timer.cancelled then f.clock=math.max(f.clock,timer.at);timer.fn();return end
   end
  end
  function f.take(method)
   for i,r in f.requests do if r.method==(method or 'GET') then table.remove(f.requests,i);return r end end
   error('missing host request')
  end
  function f.reply(value,request)
   (request or f.take()).callback({status=200,body=encode(value)})
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
 local function visit(node,fn)
  fn(node);for _,child in node.c or {} do visit(child,fn) end
 end
 local function contains(value,wanted)
  if type(value)=='string' then return value:find(wanted,1,true)~=nil end
  if type(value)=='table' then for _,child in value do if contains(child,wanted) then return true end end end
  return false
 end
 local function active(f)
  local result={}
  visit(f.view().main,function(n)
   if n.p and n.p.href then
    assert(not n.p.disabled and n.p.actions.click=='open','only admitted native links may be active')
    result[n.p.key]=n.p.href
   end
  end)
  return result
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
 test('action admission follows connection state and never grants device access',function()
  local f=fixture();assert(active(f).hide~=nil and active(f).paste==nil)
  local value=sample();value.approvals=2;f.send(value)
  local links=active(f)
  for _,verb in {'paste','upload','devices','transfers','approvals','hide'} do
   assert(links[verb]=='omp-bridge-panel://window-1/panel-1/'..verb)
  end
  value.connected=false;f.send(value);links=active(f)
  assert(links.hide~=nil and links.paste==nil and links.upload==nil and links.devices==nil and links.approvals==nil and links.transfers==nil)
  visit(f.view().main,function(n)
   if n.k=='button' and n.p.key~='hide' then
    assert(type(n.p.disabled)=='string' and #n.p.disabled>0 and n.p.href==nil and n.p.actions==nil)
   end
  end)
 end)
 test('expiry boundary and foreign snapshots cannot extend action authority',function()
  local f=fixture();f.send(sample());local deadline=f.state.expiresAt
  local foreign=sample();foreign.owner='another-window';f.send(foreign)
  assert(f.state.expiresAt==deadline)
  f.clock=deadline-1;assert(active(f).paste~=nil)
  f.clock=deadline;assert(active(f).paste==nil and f.state.snapshot==nil)
  assert(active(f).hide~=nil)
 end)
 test('saved snapshots never restore authority and initial waiting is bounded',function()
  local f=fixture(nil,{snapshot=sample(),owner='window-1',panelId='panel-1',expiresAt=999999})
  assert(active(f).paste==nil and f.state.snapshot==nil)
  assert(contains(f.view(),'Connecting to the remote session'))
  f.clock=15000
  assert(contains(f.view(),'Session unavailable') and active(f).paste==nil)
  f.send(sample());assert(active(f).paste~=nil and not f.state.expired)
 end)
 test('host rendering and forwarded gestures never execute window operations',function()
  local f=fixture();f.send(sample());local requests=#f.requests
  for _,verb in {'paste','upload','devices','transfers','approvals'} do
   if f.def.event then f.def.event(f.state,{ev='action',act=verb,id='main.'..verb},f.cx) end
  end
  if f.def.event then f.def.event(f.state,{ev='select',id='main.devices',item='device-1'},f.cx) end
  assert(f.def.key(f.state,{key='enter'},f.cx)==false)
  f.view();f.view();assert(#f.requests==requests and f.exits==0)
  f.handlers.pane_exited({pane=999});assert(not f.state.closed and #f.requests==requests)
  f.close();assert(next(active(f))==nil)
 end)
 test('nested private fields and malformed numeric values stay outside the public view',function()
  local f=fixture();local value=sample()
  value.token='PRIVATE-SENTINEL';value.devices[1].credentials={token='PRIVATE-SENTINEL'}
  value.transfers[1].localPath='PRIVATE-SENTINEL';value.transfers[1].href='PRIVATE-SENTINEL'
  value.transfers[1].bytesSent=math.huge;value.transfers[1].totalBytes=-1
  value.source='Laptop\nname';value.target=string.char(255);value.approvals=10000
  f.send(value);local s=f.state.snapshot
  assert(not contains(s,'PRIVATE-SENTINEL') and not contains(f.view(),'PRIVATE-SENTINEL'))
  assert(s.source=='Laptop name' and s.target=='No remote OMP target' and s.approvals==9999)
  assert(s.transfers[1].bytesSent==0 and s.transfers[1].totalBytes==0)
  f.tick();f.take().callback({status=200,body=string.rep('x',65536+1025)})
  assert(f.state.snapshot==s)
 end)
 test('multiple host blocks retain independent routing and close ownership',function()
  local f=fixture();f.send(sample())
  local otherCx={pane=202,render=function()end,exit=function()error('foreign block exited')end}
  local other=f.def.init(otherCx,{'window-2','panel-2','client-2'},nil)
  f.tick();local request=f.take()
  assert(request.url:find('clientId=client-2&owner=window-2&panelId=panel-2',1,true))
  local value=sample();value.owner='window-2';value.panelId='panel-2';value.source='Other laptop'
  f.reply({closed=false,snapshot=value},request)
  assert(other.snapshot.source=='Other laptop' and f.state.snapshot.source=='Laptop')
  visit(f.def.view(other,otherCx).main,function(n)
   if n.p and n.p.href then assert(n.p.href=='omp-bridge-panel://window-2/panel-2/'..n.p.key) end
  end)
  f.close();local ack=f.take('POST');assert(ack.body.owner=='window-1' and not other.closed)
  assert(next(active(f))==nil and other.snapshot~=nil)
  f.handlers.pane_exited({pane=202});ack=f.take('POST');assert(ack.body.owner=='window-2')
 end)
 test('public collection limits keep omitted entries and hidden owner metadata bounded',function()
  local f=fixture();local value=sample();value.devices={};value.transfers={}
  for i=1,33 do table.insert(value.devices,{name=i==33 and 'OMITTED-DEVICE' or 'Device',platform='linux',online=true})end
  for i=1,21 do table.insert(value.transfers,{name=i==21 and 'OMITTED-TRANSFER' or 'File',phase='failed',bytesSent=1e20,totalBytes=1e20})end
  f.send(value);local view=f.view();local ownerCount=0
  assert(f.state.snapshot.devicesMore==1 and f.state.snapshot.transfersMore==1)
  assert(f.state.snapshot.transfers[1].bytesSent==9007199254740991 and f.state.snapshot.transfers[1].totalBytes==9007199254740991)
  assert(not contains(view,'OMITTED-DEVICE') and not contains(view,'OMITTED-TRANSFER'))
  visit(view.main,function(n)
   if n.p and n.p.role=='omp.client-bridge.panel-owner' then
    ownerCount+=1;assert(n.p.hidden==true and n.p.text=='window-1/panel-1')
   end
  end)
  assert(ownerCount==1)
 end)
 test('empty device and transfer collections explain the next local action',function()
  local f=fixture();local value=sample();value.devices={};value.transfers={};f.send(value)
  local view=f.view()
  assert(contains(view,'No devices available') and contains(view,'No transfers yet'))
  assert(active(f).devices~=nil and active(f).upload~=nil and active(f).approvals==nil)
 end)
 print('Host panel regression: '..passed..' cases passed (synthetic SDK boundary only)')
end
