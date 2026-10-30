-- SPDX-License-Identifier: MPL-2.0
-- Exercises the shipped coordinator, with native work forbidden in process callbacks.
function run(Controller)
 local passed=0
 local function fixture(remoteUi)
  local f={clock=1,timers={},processes={},picks={},snapshots={},writes={},splits=0,resizes=0,remoteUi=remoteUi~=false,inProcess=false,connected=0,session=1,tab=1,views={},closed={},focuses={},nativeCalls=0,maxNative=0}
  f.awaits,f.terminals,f.launches={},{},{}
  f.configProcesses,f.effective,f.configFiles={},{},{}
  local serial,encoded=0,{}
  local function copy(x) if type(x)~='table' then return x end local r={} for k,v in x do r[k]=copy(v) end return r end
  local function native() assert(not f.inProcess,'process callback performed synchronous native/UI work') end
  f.remote={id=2,name='Agent',kind='remote',state='connected',address='agent.example',panes={10}}
  f.localHost={id=1,name='local',kind='local',state='connected',panes={20}}
  f.current=f.remote
  local function json(value) serial+=1 local key='json-'..serial encoded[key]=copy(value) return key end
  local api={plugin={dir='/plugin',data='/data'},runtime={os='macos'},now=function() native();return f.clock end,
   timer=function(_,callback) native();table.insert(f.timers,callback) end,
   kv={get=function() native();return copy(f.mapping) end,set=function(_,value) native();f.mapping=copy(value);table.insert(f.writes,copy(value)) end},
   json={encode=function(v) native();return json(v) end,decode=function(v) native();return copy(assert(encoded[v],'invalid JSON')) end},
   fs={read=function(file) native();if f.configFiles[file] then return f.configFiles[file] end return json(assert(f.progress,'missing progress')) end},
   process={run=function(argv,opts,callback)
    native()
    if table.find(argv,'-G') then
     table.insert(f.configProcesses,{argv=argv,options=opts})
     local destination=argv[#argv]
     local user,host=destination:match('^([^@]+)@(.+)$');host=host or destination
     local resolved=f.effective[destination] or ('hostname '..host..'\nuser '..(user or 'fixture')..'\nport 22\n')
     f.inProcess=true;callback({status=0,stdout=resolved,stderr=f.configPath and ('debug1: Reading configuration data '..f.configPath..'\n') or '',timed_out=false});f.inProcess=false
    else table.insert(f.processes,{argv=argv,options=opts,callback=callback}) end
   end}}
  local controller=Controller.new(api,{owner='window-test',bootstrap={new=function()return {step=function()return f.payload or 'native-ui-fixture-command'end}end},onState=function() end,refresh=function() native() end,onConnected=function() native();f.connected+=1;return f.readiness or 'awaiting',f.readinessMessage end})
  local function invoke(callback)
   local alive=true
   local function live() native();assert(alive,'expired window context') end
   f.nativeCalls=0
   local function viewCall() live();f.nativeCalls+=1 end
   local function active(view) return view.host==f.current.id and view.session==f.session end
   local cx={hosts={current=function() live();return f.current end,list=function() live();return {f.localHost,f.remote} end,switch=function(_,name) viewCall();assert(name=='local');f.current=f.localHost end},
    sessions={current=function() live();return {id=f.session,host=f.current.id} end},
    session={focused=function() live();return f.current.id==2 and 10 or 20 end,
     pane=function(_,id) viewCall();local view=f.views[id];if view then assert(active(view),'read a setup pane from a different session/host');return {pane=id,kind='plugin',block=view.kind,tab=view.tab} end if f.terminals[id] then return {pane=id,kind='terminal',at_prompt=true,tab=f.tab} end if id==10 or id==20 then return {pane=id,kind='agent',tab=f.tab} end return nil end,
     layout=function() viewCall();return {root={pane=f.current.id==2 and 10 or 20}} end,
     surface=function(_,id) viewCall();assert(f.views[id] and active(f.views[id]),'surface read targeted stale pane');if f.surfaceReady==false then return nil end;return {surface={role='plugin.'..f.views[id].kind}} end,
     block_types=function() viewCall();return f.current.id==1 and {{kind='omp-client-bridge.setup'}} or (f.remoteUi and {{kind='omp-bridge-setup.panel'}} or {}) end,
     settle=function(_,pane) viewCall();assert(f.terminals[pane]);return {next=function(_,callback)live();table.insert(f.awaits,{pane=pane,callback=callback})end}end,
     event=function(_,pane,ev) viewCall();assert(f.views[pane] and active(f.views[pane]),'snapshot targeted stale pane');assert(ev.act=='setup-snapshot');table.insert(f.snapshots,copy(encoded[ev.value])) end},
    layout={split=function(_,edge,_,launch) viewCall();f.splits+=1;local id='host-'..f.current.id..'-pane-'..f.splits;if not launch.block then f.terminals[id]=true;return id end f.pane=id;f.kind=launch.block;f.edge=edge;f.views[id]={kind=launch.block,host=f.current.id,session=f.session,tab=f.tab};return id end,resize=function() viewCall();f.resizes+=1 end,focus=function(_,pane) viewCall();assert(f.views[pane] and active(f.views[pane]),'focused stale setup pane');table.insert(f.focuses,pane) end,close=function(_,pane) viewCall();table.insert(f.closed,pane);f.terminals[pane]=nil;f.views[pane]=nil;if pane==f.pane then f.pane=nil end end},
    run=function(_,pane,command) viewCall();assert(f.terminals[pane]);table.insert(f.launches,{pane=pane,command=command}) end,
    pick=function(_,opts) viewCall();return {next=function(_,callback) live();table.insert(f.picks,{options=opts,callback=callback}) end} end,
    toast=function(_,_,_,message) live();f.toast=message end}
   callback(cx);f.maxNative=math.max(f.maxNative,f.nativeCalls);alive=false
  end
  function f.open() invoke(controller.open) end
  function f.tick() f.clock+=100;invoke(assert(table.remove(f.timers,1),'missing pump')) end
  function f.until_(predicate) for _=1,300 do if predicate() then return end f.tick() end error('state did not settle: '..controller.status().phase) end
  function f.latest() return f.snapshots[#f.snapshots] end
  function f.display() f.until_(function() local s=controller.status();return not s.receipt and f.latest() and f.latest().panelId==s.panelId and f.latest().revision==s.revision and #s.jobs==0 end) end
  function f.action(verb,value,revision,owner)
   local s=controller.status()
   local encodedValue=value and ('/'..value:gsub('.',function(c)return string.format('%%%02X',string.byte(c))end)) or ''
   invoke(function(cx) controller.route({pane=f.pane,url='omp-bridge-setup://'..(owner or s.owner)..'/'..s.panelId..'/'..tostring(revision or s.revision)..'/'..verb..encodedValue},cx) end)
  end
  function f.finish(result)
   local process=assert(table.remove(f.processes,1),'missing process')
   f.inProcess=true;local ok,err=pcall(process.callback,result);f.inProcess=false;assert(ok,err)
  end
  function f.nativeFinish(failed)
   local awaited=assert(table.remove(f.awaits,1),'missing native completion')
   f.inProcess=true
   controller.commandFinished({pane=awaited.pane,status=failed and 1 or 0})
   local ok,err=pcall(awaited.callback,failed and 'failed' or ('TERN_OMP_SETUP_UI_V1 READY '..controller.status().nonce..'\n'),nil)
   f.inProcess=false;assert(ok,err)
  end
  function f.probe(ok) f.finish({status=ok==false and 255 or 0,stdout=ok==false and '' or 'TERN_OMP_SSH_PREFLIGHT_V1\tLinux\tx86_64\n',stderr=ok==false and 'Permission denied SECRET' or '',timed_out=false}) end
  function f.choice(decision) local pick=assert(table.remove(f.picks,1));invoke(function(cx)pick.callback({decision=decision},nil,cx)end) end
  function f.result(status) f.finish({status=0,stdout=json({schema=1,kind='setup-complete',host=controller.status().ssh,status=status or 'awaiting_session',stage='awaiting-session',message='Open a new session'}),stderr='',timed_out=false}) end
  function f.status() return controller.status() end
  function f.link(verb) local s=controller.status();return {pane=f.pane,url='omp-bridge-setup://'..s.owner..'/'..s.panelId..'/'..s.revision..'/'..verb} end
  function f.route(req) invoke(function(cx) controller.route(req,cx) end) end
  function f.externalClose(notify) local pane=f.pane;f.views[pane]=nil;f.pane=nil;if notify then controller.closed(pane) end;return pane end
  function f.notifyClosed(pane) controller.closed(pane) end
  function f.hide() invoke(controller.hide) end
  function f.review() f.open();f.display();f.action('check','agent.example');f.until_(function()return #f.processes==1 end);f.probe();assert(f.status().phase=='checking','process callback advanced UI synchronously');f.display();assert(f.latest().phase=='review' and f.latest().canInstall) end
  return f
 end
 local function case(name,fn)fn();passed+=1;print('PASS setup coordinator: '..name)end
 case('existing renderer opens inline without process or modal',function()
  local f=fixture();f.open();f.display();assert(f.splits==1 and #f.processes==0 and #f.picks==0 and f.latest().phase=='choose');assert(f.resizes==0,'setup must retain the native split width rather than force a fixed shrink')
 end)
 case('receipt-only probe callback cannot trigger native budget work',function()
  local f=fixture();f.review();assert(#f.picks==0 and #f.writes==0)
 end)
 case('failed check stays failed and never authorizes installation',function()
  local f=fixture();f.open();f.display();f.action('check','agent.example');f.until_(function()return #f.processes==1 end);f.probe(false);f.display();assert(f.latest().phase=='failed' and not f.latest().canInstall and not f.latest().error:find('SECRET',1,true));f.action('install','agent.example');assert(#f.processes==0)
 end)
 case('duplicate check and install clicks remain single flight',function()
  local f=fixture();f.open();f.display();f.action('check','agent.example');f.action('check','agent.example');f.until_(function()return #f.processes==1 end);f.probe();f.display();f.action('install','agent.example');f.action('install','agent.example');f.until_(function()return #f.processes==1 end);assert(#f.writes==1 and f.processes[1].argv[2]=='/plugin/scripts/bootstrap.sh')
 end)
 case('wrong owner, stale revision and changed SSH cannot install',function()
  local f=fixture();f.review();f.action('install','agent.example',nil,'other-window');f.action('install','agent.example',f.status().revision-1);f.action('install','other.example');assert(#f.processes==0 and #f.writes==0)
 end)
 case('current host switch rejects old view links but preserves reviewed target on reopen',function()
  local f=fixture();f.review();local old=f.link('install/%61%67%65%6e%74%2e%65%78%61%6d%70%6c%65');f.current=f.localHost;f.route(old);assert(#f.processes==0);f.open();f.display();assert(f.latest().ssh=='agent.example' and f.latest().phase=='review');f.action('install','agent.example');f.until_(function()return #f.processes==1 end);assert(f.processes[1].argv[#f.processes[1].argv]=='agent.example')
 end)
 case('selected target replacement blocks approved launch',function()
  local f=fixture();f.review();f.remote.address='replacement.example';f.action('install','agent.example');f.display();assert(f.latest().phase=='failed' and #f.processes==0 and #f.writes==0)
 end)
 case('read-only check timeout fails and late success cannot authorize installation',function()
  local f=fixture();f.open();f.display();f.action('check','agent.example');f.until_(function()return #f.processes==1 end);f.clock+=34000;f.tick();f.display();assert(f.latest().phase=='failed' and not f.latest().canInstall);f.probe();f.tick();assert(f.status().phase=='failed')
 end)
 case('opaque native address can use local sidebar without guessing SSH name',function()
  local f=fixture(false);f.remote.address=string.rep('a',64);f.remote.name='do-not-use-as-ssh';f.open();f.until_(function()return #f.picks==1 end);assert(#f.processes==0);f.choice('local');f.display();assert(f.current.id==1 and f.kind=='omp-client-bridge.setup' and f.latest().ssh=='' and #f.processes==0)
 end)
 case('cold UI deployment reuses native connection without SSH or runtime',function()
  local f=fixture(false);f.remote.address=string.rep('a',64);f.open();f.until_(function()return #f.picks==1 end)
  assert(#f.processes==0 and f.splits==0,'cold UI opened a process/pane before consent')
  f.choice('remote');f.until_(function()return #f.awaits==1 end);assert(#f.processes==0,'native UI started a local launcher')
  local sent='';for _,part in f.launches do assert(#part.command<=512,'native UI chunk exceeded limit');sent..=part.command end
  assert(sent=='\27[200~native-ui-fixture-command\27[201~\r','native UI payload differs: '..string.format('%q',sent))
  f.remoteUi=true;f.nativeFinish();f.display()
  assert(f.current.id==2,'native UI unexpectedly switched host: '..tostring(f.latest().message))
  assert(not f.latest().canInstall,'native UI authorized runtime installation')
  assert(f.latest().phase=='choose','native UI phase: '..tostring(f.latest().phase)..' / '..tostring(f.latest().message))
  assert(#f.writes==0,'native UI wrote runtime approval mapping')
  assert(next(f.terminals)==nil,'native UI left its owned preparation terminal open')
 end)
 case('native UI deployment failure falls back locally without runtime install',function()
  local f=fixture(false);f.open();f.until_(function()return #f.picks==1 end);f.choice('remote');f.until_(function()return #f.awaits==1 end);f.nativeFinish(true);f.display();assert(f.current.id==1 and f.latest().phase=='failed' and #f.processes==0)
 end)
 case('refresh does not create another sidebar',function()
  local f=fixture();f.open();f.display();f.action('refresh');f.tick();f.display();assert(f.splits==1)
 end)
 case('installation completion is verified outside callback',function()
  local f=fixture();f.review();f.action('install','agent.example');f.until_(function()return #f.processes==1 end);f.result();assert(f.status().phase=='installing' and f.connected==0);f.display();assert(f.latest().phase=='awaiting_session' and f.connected==1)
 end)
 case('expired view still allows its owner to hide',function()
  local f=fixture();f.open();f.display();f.action('hide',nil,f.status().revision-1);assert(not f.pane)
 end)
 case('UI preparation consent cannot be duplicated or silently accepted',function()
  local f=fixture(false);f.open();f.until_(function()return #f.picks==1 end);f.open();for _=1,8 do if #f.timers>0 then f.tick() end end;assert(#f.picks==1 and #f.launches==0 and #f.processes==0);f.choice('cancel');assert(#f.launches==0 and #f.processes==0)
 end)
 case('hide and reopen preserve active installation and frozen target',function()
  local f=fixture();f.review();f.action('install','agent.example');f.until_(function()return #f.processes==1 end);f.action('hide');f.current=f.localHost;f.open();f.display();assert(f.latest().phase=='installing' and f.latest().busy and f.latest().ssh=='agent.example' and #f.processes==1)
 end)
 case('existing running record is shown as unverified rather than completed',function()
  local f=fixture();f.progress={schema=1,status='installing',host='agent.example',stage='starting-client'};f.open();f.display();assert(f.latest().phase=='interrupted' and not f.latest().canInstall and #f.processes==0)
 end)
 case('known lock recovery remains a separate affirmative action',function()
  local f=fixture();f.progress={schema=1,status='failed',stage='lock_recovery_required'};f.review();assert(f.latest().canRecover);f.action('recover','agent.example');f.until_(function()return #f.processes==1 end);assert(f.processes[1].argv[#f.processes[1].argv]=='--recover-lock')
 end)
 case('snapshot waits for the native view to exist before publishing',function()
  local f=fixture();f.surfaceReady=false;f.open();f.until_(function()return f.pane~=nil end);for _=1,10 do f.tick() end;assert(#f.snapshots==0);f.surfaceReady=true;f.display();assert(f.latest().phase=='choose')
 end)
 case('native payload chunks preserve Unicode and submit only after the complete command',function()
  local f=fixture(false);f.payload='x'..string.rep('界',600);f.open();f.until_(function()return #f.picks==1 end);f.choice('remote');f.until_(function()return #f.awaits==1 end);local sent='';for i,part in f.launches do assert(#part.command<=512 and utf8.len(part.command));if i<#f.launches then assert(not part.command:find('\r',1,true)) end;sent..=part.command end;assert(sent=='\27[200~'..f.payload..'\27[201~\r')
 end)
 case('explicit canonical selection automatically queues exactly one bounded read-only check',function()
  local f=fixture();f.open();f.display();assert(#f.processes==0);f.action('select','1');f.action('select','1');f.until_(function()return #f.processes==1 end);assert(f.processes[1].argv[1]=='ssh' and f.processes[1].options.timeout_ms==30000);f.probe();f.display();assert(f.latest().phase=='review' and #f.writes==0);f.action('select','1');f.display();f.action('refresh');f.display();f.open();f.display();assert(#f.processes==0 and #f.writes==0 and f.latest().phase=='review')
 end)
 case('mapped selection auto-checks while opaque and manual selections require an address',function()
  local f=fixture();f.remote.address=string.rep('a',64);f.open();f.display();f.action('select','1');f.display();assert(#f.processes==0 and f.latest().ssh=='');f.action('select','2');f.display();assert(#f.processes==0 and f.latest().ssh=='');f.mapping={schema=1,hosts={[f.remote.address]='approved-alias'}};f.action('select','1');f.until_(function()return #f.processes==1 end);assert(f.processes[1].argv[#f.processes[1].argv-1]=='approved-alias')
 end)
 case('opening in another session closes the old view and makes every old link inert',function()
  local f=fixture();f.review();local old=f.pane;local hide=f.link('hide');f.session=2;f.open();f.display();assert(f.pane~=old and not f.views[old] and f.views[f.pane].session==2 and f.latest().phase=='review');local current=f.pane;f.route(hide);f.notifyClosed(old);assert(f.pane==current and f.status().pane==current and #f.processes==0)
 end)
 case('externally closed pane reopens in the caller tab without focusing a missing pane',function()
  local f=fixture();f.review();f.externalClose(false);f.session=2;f.tab=2;f.open();f.display();assert(f.views[f.pane].session==2 and f.views[f.pane].tab==2 and #f.focuses==0 and f.latest().canInstall)
 end)
 case('a hidden in-flight probe survives session rehome and its receipt advances only the new view',function()
  local f=fixture();f.open();f.display();f.action('check','agent.example');f.until_(function()return #f.processes==1 end);local old=f.pane;f.action('hide');f.session=2;f.open();f.until_(function()return f.pane~=nil end);f.probe();f.display();assert(f.latest().phase=='review' and not f.views[old] and f.views[f.pane].session==2 and #f.processes==0)
 end)
 case('in-flight install survives direct session rehome and never repeats after completion',function()
  local f=fixture();f.review();f.action('install','agent.example');f.until_(function()return #f.processes==1 end);local old=f.pane;f.session=2;f.open();f.display();assert(not f.views[old] and f.latest().phase=='installing' and #f.processes==1);f.result();f.display();assert(f.latest().phase=='awaiting_session');f.action('retry');f.display();f.action('refresh');f.display();f.open();f.display();assert(#f.processes==0 and #f.writes==1 and f.latest().phase=='awaiting_session')
 end)
 case('late view readiness deadline cannot fail a completed installation or wedge reopen',function()
  local f=fixture();f.review();f.action('install','agent.example');f.until_(function()return #f.processes==1 end);f.surfaceReady=false;f.session=2;f.open();f.until_(function()return f.pane~=nil end);f.result();f.until_(function()return f.connected==1 end);f.clock+=12000;for _=1,8 do if #f.timers>0 then f.tick() end end;assert(f.status().phase=='awaiting_session');f.externalClose(true);f.surfaceReady=true;f.open();f.display();assert(f.latest().phase=='awaiting_session' and #f.processes==0)
 end)
 case('retry is explicit single flight and does not repeat a successful check',function()
  local f=fixture();f.open();f.display();f.action('check','agent.example');f.until_(function()return #f.processes==1 end);f.probe(false);f.display();f.action('retry');f.action('retry');f.until_(function()return #f.processes==1 end);f.probe();f.display();f.action('retry');f.action('check','agent.example');f.display();assert(#f.processes==0 and f.latest().phase=='review' and #f.writes==0)
 end)
 case('endpoint metadata absence or readiness error cannot invalidate verified installation',function()
  for _,readiness in {'awaiting','error'} do local f=fixture();f.readiness=readiness;f.readinessMessage='Connection metadata is not available yet';f.review();f.action('install','agent.example');f.until_(function()return #f.processes==1 end);f.result('ready');f.display();assert(f.latest().phase=='awaiting_session' and not f.latest().error and #f.processes==0) end
 end)
 case('view native reads and mutations are staged across timer callbacks',function()
  local f=fixture();f.review();assert(f.maxNative<=1,'multiple heavy native view calls shared a callback')
 end)
 case('changing session without reopening never reads or publishes the old setup view',function()
  local f=fixture();f.review();local count=#f.snapshots;f.session=2;f.clock+=6000;for _=1,8 do if #f.timers>0 then f.tick() end end;assert(#f.snapshots==count and f.status().phase=='review');f.open();f.display();assert(f.latest().phase=='review')
 end)
 case('delayed endpoint readiness restores only the installer verified completion state',function()
  for _,completion in {'ready','awaiting_session'} do local f=fixture();f.review();f.action('install','agent.example');f.until_(function()return #f.processes==1 end);f.result(completion);f.display();assert(f.latest().phase=='awaiting_session' and f.latest().stage=='awaiting-local-endpoint');f.readiness='ready';f.clock+=2000;f.until_(function()return f.status().stage=='awaiting-session' end);f.display();assert(f.latest().phase==completion and #f.processes==0) end
 end)
 case('ordinary Bridge dismissal retires only setup display and retains in-flight receipt',function()
  local f=fixture();f.review();f.action('install','agent.example');f.until_(function()return #f.processes==1 end);local old=f.pane;f.session=2;f.hide();f.until_(function()return not f.views[old] end);f.result();f.until_(function()return f.connected==1 end);assert(f.status().phase=='awaiting_session' and f.status().ssh=='agent.example');f.open();f.display();assert(f.views[f.pane].session==2 and #f.processes==0 and #f.writes==1)
 end)
 case('catalog readiness jobs from the old session cannot wedge a reopened setup view',function()
  local f=fixture(false);f.open();f.until_(function()return #f.picks==1 end);f.choice('remote');f.until_(function()return #f.awaits==1 end);f.nativeFinish();f.until_(function()return f.status().catalogDeadline~=nil end);f.session=2;f.remoteUi=true;f.open();f.display();assert(f.views[f.pane].session==2 and f.latest().phase=='choose' and #f.processes==0 and next(f.terminals)==nil)
 end)
 case('native interface receipt survives rehome without reading or recreating the old session',function()
  local f=fixture(false);f.open();f.until_(function()return #f.picks==1 end);f.choice('remote');f.until_(function()return #f.awaits==1 end);f.session=2;f.remoteUi=true;f.open();f.display();f.nativeFinish();f.display();assert(f.views[f.pane].session==2 and f.latest().phase=='choose' and #f.processes==0 and next(f.terminals)==nil and f.maxNative<=1)
 end)
 case('old consent callback cannot launch interface preparation after another session opens',function()
  local f=fixture(false);f.open();f.until_(function()return #f.picks==1 end);f.session=2;f.remoteUi=true;f.open();f.display();f.choice('remote');for _=1,5 do if #f.timers>0 then f.tick() end end;assert(#f.launches==0 and #f.processes==0 and next(f.terminals)==nil)
 end)
 case('approved installation rejects a target replaced between staged validation and launch',function()
  local f=fixture();f.review();f.action('install','agent.example');f.until_(function()return #f.writes==1 end);f.remote.address='replacement.example';f.display();assert(f.latest().phase=='failed' and #f.processes==0)
 end)
 local function profiles()
  local f=fixture();f.remote.address='root@192.0.2.8';f.configPath='/ssh/config'
  f.configFiles[f.configPath]='Host first-profile second-profile\n HostName 192.0.2.8\n User root\nHost unrelated\n HostName 192.0.2.99\n'
  for _,alias in {'first-profile','second-profile'} do f.effective[alias]='hostname 192.0.2.8\nuser root\nport 2222\n' end
  f.effective.unrelated='hostname 192.0.2.99\nuser root\nport 22\n'
  return f
 end
 case('cold native address discovers a configured alias without a saved mapping or SSH login',function()
  local f=profiles();f.open();f.display();assert(f.latest().ssh=='first-profile' and f.latest().sshSource=='config');assert(f.latest().canDiscover and #f.processes==0 and #f.writes==0)
 end)
 case('automatic checks advance from failed profile to related success and preserve the evidence',function()
  local f=profiles();f.open();f.display();f.action('checkprofiles','first-profile');f.until_(function()return #f.processes==1 end);assert(f.processes[1].argv[#f.processes[1].argv-1]=='first-profile');f.probe(false)
  f.until_(function()return #f.processes==1 end);assert(f.processes[1].argv[#f.processes[1].argv-1]=='second-profile');f.probe();f.display()
  local s=f.latest();assert(s.phase=='review' and s.ssh=='second-profile' and s.canInstall and not s.busy);assert(#s.attempts==2 and s.attempts[1].status=='failed' and s.attempts[2].status=='passed');assert(not s.attempts[1].message:find('SECRET',1,true) and #f.processes==0 and #f.writes==0)
 end)
 case('manual check of the suggested profile never falls back and a corrected alias becomes authoritative',function()
  local f=profiles();f.open();f.display();f.action('check','first-profile');f.until_(function()return #f.processes==1 end);f.probe(false);f.display();assert(f.latest().phase=='failed' and f.latest().ssh=='first-profile' and f.latest().sshSource=='manual' and #f.processes==0 and #f.latest().attempts==1)
  f.action('check','second-profile');f.until_(function()return #f.processes==1 end);assert(f.processes[1].argv[#f.processes[1].argv-1]=='second-profile');f.probe();f.display();assert(f.latest().phase=='review' and f.latest().sshSource=='manual' and f.status().probe.ssh=='second-profile')
 end)
 case('explicit alternatives can recover from a saved obsolete SSH mapping',function()
  local f=profiles();f.mapping={schema=1,hosts={[f.remote.address]='obsolete-alias'}};f.open();f.display();assert(f.latest().ssh=='obsolete-alias');f.action('discover');f.until_(function()return #f.processes==1 end);f.probe(false);f.until_(function()return #f.processes==1 end);assert(f.processes[1].argv[#f.processes[1].argv-1]=='first-profile');f.probe();f.display();assert(f.latest().phase=='review' and f.latest().ssh=='first-profile' and #f.writes==0)
 end)
 case('selected-host replacement during local discovery stops before authentication',function()
  local f=profiles();f.open();f.until_(function()return f.status().discovery~=nil end);f.remote.address='other.example';f.display();assert(f.latest().phase=='failed' and not f.latest().canInstall and #f.processes==0)
 end)
 case('automatic checks stop at the overall deadline without installing or retrying',function()
  local f=profiles();f.open();f.display();f.action('checkprofiles','first-profile');f.until_(function()return #f.processes==1 end);f.probe(false);f.clock+=90001;f.display();assert(f.latest().phase=='failed' and not f.latest().busy and not f.latest().canInstall and #f.processes==0 and #f.writes==0)
 end)
 case('missing installation receipt remains interrupted and late success is inert',function()
  local f=fixture();f.review();f.action('install','agent.example');f.until_(function()return #f.processes==1 end);f.clock+=904000;f.tick();f.display();assert(f.latest().phase=='interrupted' and not f.latest().canInstall);f.result();f.tick();assert(f.status().phase=='interrupted' and not f.status().completed)
 end)
 print('Setup coordinator scenarios passed: '..passed)
end
