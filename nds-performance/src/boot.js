(() => {
  const decode = name => {
    const node=document.getElementById('embedded-'+name), raw=atob(node.textContent.trim());
    const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));node.remove();return bytes;
  };
  const bundled={rom:null,js:decode('js'),wasm:decode('wasm')};
  const metadata=__METADATA__, build=__BUILD__;
  EmulatorJS.prototype.checkForUpdates=function(){};
  EmulatorJS.prototype.downloadGameCore=function(){
    if(!this.supportsWebgl2){this.startGameError('This standalone build requires WebGL 2');return;}
    this.webgl2Enabled=true;
    this.checkCoreCompatibility(build);
    this.extensions=metadata.extensions;this.coreName=metadata.name;
    this.repository=metadata.repo;this.defaultCoreOpts=metadata.options;
    this.enableMouseLock=false;
    this.retroarchOpts=metadata.retroarchOpts;this.saveFileExt=metadata.save;
    this.initGameCore(bundled.js,bundled.wasm);
  };
  EmulatorJS.prototype.downloadRom=async function(){
    this.fileName='game.nds';
    this.gameManager.FS.writeFile('/'+this.fileName,bundled.rom);
  };
  const config={system:'desmume',gameUrl:'embedded.nds',gameName:'NDS-Performance',
    dataPath:'',threads:false,volume:0.6,startOnLoad:!!window.max,
    startBtnName:'Start ROM',disableDatabases:true,disableLocalStorage:true,
    defaultOptions:{desmume_pointer_mouse:'enabled',desmume_pointer_type:'touch',desmume_input_rotation:'0',desmume_screens_layout:'left/right',desmume_screens_gap:'0',mouse:false},
    language:'en-US'};
  const label=document.getElementById('rom-status');

  function boot(bytes,name,gesture){
    const game=NDS.setGame(bytes,name);
    bundled.rom=bytes;
    if(gesture)config.startOnLoad=true;
    window.EJS_emulator=new EmulatorJS('#game',config);
    window.EJS_emulator.on('start',()=>NDS.started());
    label.textContent=game.title+' · '+game.code;
  }

  document.getElementById('rom-picker').addEventListener('change',async event=>{
    const file=event.target.files[0];if(!file)return;
    try{
      const bytes=new Uint8Array(await file.arrayBuffer());
      if(bytes.length<0x200)throw new Error('Not a DS ROM: '+file.name);
      let cached=false;
      try{await NDSStore.put('rom',{name:file.name,bytes});cached=true;}catch(_){}
      // EmulatorJS cannot swap cores in place: reload and boot the cached ROM.
      if(window.EJS_emulator){
        if(cached)location.reload();
        else label.textContent='Reload the device to change ROM';
        return;
      }
      boot(bytes,file.name,true);
    }catch(error){label.textContent=error.message;}
  });

  (async()=>{
    let cached=null;
    try{cached=await NDSStore.get('rom');}catch(_){}
    if(cached&&cached.bytes&&!window.EJS_emulator)boot(cached.bytes,cached.name,false);
  })();

  window.addEventListener('error',e=>{
    const status=document.getElementById('status');status.hidden=false;status.textContent='Error: '+e.message;
    if(window.max)window.max.outlet('error',e.message);
  });
})();
