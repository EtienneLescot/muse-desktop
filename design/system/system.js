const colors = { blue:'Action', bg:'Fond principal', side:'Navigation', surface:'Surface secondaire', text:'Texte principal', muted:'Texte secondaire', line:'Séparateur', pale:'Sélection', green:'Succès' };
function swatches(){document.querySelector('#swatches').innerHTML=Object.entries(colors).map(([token,label])=>`<div class="swatch"><div class="swatch-color" style="background:var(--${token})"></div><div class="swatch-label">${label}<code>--${token} · ${getComputedStyle(document.body).getPropertyValue('--'+token).trim()}</code></div></div>`).join('')}
document.querySelector('#theme').onclick=e=>{const dark=document.body.classList.toggle('dark');e.target.textContent=dark?'Thème clair':'Thème sombre';e.target.setAttribute('aria-pressed',dark);swatches()};
document.querySelector('#toggle').onclick=e=>{const on=e.target.classList.toggle('on');e.target.setAttribute('aria-pressed',on)};
document.querySelector('#action').onclick=()=>document.querySelector('#feedback').textContent='Action de démonstration activée.';
document.querySelector('#spacing').innerHTML=[4,8,12,16,24,32].map(n=>`<span><i style="width:${n}px"></i>${n} px</span>`).join('');swatches();
