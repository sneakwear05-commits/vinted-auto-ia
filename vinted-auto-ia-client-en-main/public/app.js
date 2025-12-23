const el = (id) => document.getElementById(id);

async function apiHealth(){
  const r = await fetch('/api/health');
  return r.json();
}

function setStatus(msg, ok=null){
  const s = el('status');
  s.textContent = msg;
  s.classList.remove('ok','bad');
  if(ok===true) s.classList.add('ok');
  if(ok===false) s.classList.add('bad');
}

function fileToDataUrl(file){
  return new Promise((resolve, reject)=>{
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function showPreview(files){
  const box = el('preview');
  box.innerHTML = '';
  [...files].slice(0, 12).forEach(f=>{
    const img = document.createElement('img');
    img.alt = f.name;
    img.src = URL.createObjectURL(f);
    box.appendChild(img);
  });
}

async function postJson(url, body){
  const r = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(()=> ({}));
  if(!r.ok) throw new Error(data?.error || ('HTTP '+r.status));
  return data;
}

async function run(){
  // health
  try{
    const h = await apiHealth();
    if(h.ok && h.hasKey){
      setStatus('api ok (ia active)', true);
    }else if(h.ok && !h.hasKey){
      setStatus('api ok (ajoute OPENAI_API_KEY sur Render)', false);
    }else{
      setStatus('api inaccessible', false);
    }
  }catch(e){
    setStatus('api inaccessible', false);
  }

  el('photos').addEventListener('change', (e)=> showPreview(e.target.files));

  el('go').addEventListener('click', async ()=>{
    const files = el('photos').files;
    if(!files || files.length === 0) return alert('Ajoute au moins 1 photo.');

    const useAi = el('useAi').checked;
    const useMannequin = el('useMannequin').checked;
    const gender = el('gender').value;
    const extra = el('extra').value || '';

    el('progress').hidden = false;
    el('go').disabled = true;
    el('copyTitle').disabled = true;
    el('copyDesc').disabled = true;

    el('outTitle').textContent = '';
    el('outDesc').textContent = '';
    el('outPrice').textContent = '';
    el('mannequinBox').innerHTML = '<div class="hint">génération…</div>';

    try{
      const imgs = [];
      for(const f of [...files].slice(0, 8)){
        imgs.push(await fileToDataUrl(f));
      }

      // 1) listing
      const listing = await postJson('/api/generate-listing', { useAi, images: imgs, extra });
      el('outTitle').textContent = listing.title || '';
      el('outDesc').textContent = listing.description || '';
      el('outPrice').textContent = listing.price || '';

      el('copyTitle').disabled = !listing.title;
      el('copyDesc').disabled = !listing.description;

      // 2) mannequin
      if(useAi && useMannequin){
        const m = await postJson('/api/generate-mannequin', {
          gender,
          // on donne la description, ça suffit pour un premier rendu
          description: listing.mannequin_prompt || listing.title || 'vêtement'
        });
        if(m.image_data_url){
          el('mannequinBox').innerHTML = '';
          const img = document.createElement('img');
          img.src = m.image_data_url;
          img.alt = 'photo mannequin';
          el('mannequinBox').appendChild(img);
        }else{
          el('mannequinBox').innerHTML = '<div class="hint">pas d’image renvoyée</div>';
        }
      }else{
        el('mannequinBox').innerHTML = '<div class="hint">désactivé</div>';
      }

      // copy buttons
      el('copyTitle').onclick = async ()=> {
        await navigator.clipboard.writeText(el('outTitle').textContent);
        alert('Titre copié.');
      };
      el('copyDesc').onclick = async ()=> {
        await navigator.clipboard.writeText(el('outDesc').textContent);
        alert('Description copiée.');
      };

    }catch(e){
      console.error(e);
      alert('Erreur : ' + (e?.message || e));
      el('mannequinBox').innerHTML = '<div class="hint">erreur</div>';
    }finally{
      el('progress').hidden = true;
      el('go').disabled = false;
    }
  });

  // PWA install cache
  if('serviceWorker' in navigator){
    try{ await navigator.serviceWorker.register('/service-worker.js'); }catch(e){}
  }
}

run();
