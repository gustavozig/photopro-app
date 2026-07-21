// prompts.js
// "Prompts mágicos" — um por estilo. A parte de preservação de identidade é
// compartilhada por todos, porque é a promessa central do produto:
// "continua sendo você, só que pronto para currículo e LinkedIn".

const IDENTITY_LOCK = `
This is a photo EDIT, not a new generation: you are taking the exact person in the
attached selfie and changing only their clothing, background, and lighting — treat the
face itself as a fixed element being composited into a new scene, not something to redraw
from scratch.
IMPORTANT distinction — identity vs. framing: preserve the person's FACE with maximum
fidelity (see below), but do NOT preserve the CAMERA FRAMING of the input photo. The input
is typically a close-up selfie taken at arm's length (face filling almost the entire
frame, little to no shoulders visible, top of the head often cropped off). The output must
use a completely different, wider framing — see the "Framing" section below. Do not simply
lightly crop, upscale, or zoom out slightly from the selfie as it is; recompose the shot
entirely, as if a photographer stepped back a few meters and reshot this person with a
proper camera and studio setup, keeping only the face/identity anchored to the original.
CRITICAL — identity preservation (do not violate):
- Keep the exact same person: same face shape, same eyes and eye spacing, same eyebrow
  shape, same nose, same mouth and lip shape, same jawline and chin, same ears, same skin
  tone, same hairstyle, hairline and hair color, same approximate age.
- Preserve any distinctive, identity-defining features exactly as shown in the original
  photo — moles, freckles, scars, dimples, facial hair, glasses, asymmetries. These are
  what make the person recognizable; removing or "fixing" them defeats the purpose.
- Do not beautify, slim, reshape, or idealize the face. Do not change ethnicity or gender
  presentation. Do not enlarge the eyes, whiten the teeth beyond reality, or symmetrize
  the face artificially. This is not a filter or a digital-avatar generator — it is a
  realistic edit of a real person's real face.
- Preserve natural skin texture — visible pores, subtle blemishes, natural texture — this
  must look like a real unedited photograph of this exact person, not an idealized avatar.
- The result must pass this test: someone who knows this person well should recognize them
  instantly, with zero doubt, purely from the face — before even noticing the new clothes
  or background.
Natural, realistic look (avoid the typical over-processed "AI portrait" look):
- True-to-life, natural color grading: accurate, neutral skin tones. Do NOT oversaturate
  colors, do NOT apply HDR/neon color grading, do NOT over-sharpen.
- Skin must look natural and matte-to-slightly-natural-sheen, never waxy, plastic-looking,
  or airbrushed smooth.
- Avoid exaggerated contrast or crushed shadows — soft, realistic dynamic range like an
  unedited DSLR portrait, not a heavily filtered social-media photo.
Framing (must be consistent every time):
- Head-and-shoulders composition: crop from roughly mid-chest up.
- Face centered horizontally, eyes positioned around the upper third of the frame, face
  occupying roughly 35-45% of the frame height — not an extreme close-up, not a distant/
  full-body shot.
- Both shoulders visible and level, camera at eye level, subject looking directly at the
  camera with a natural, relaxed expression (no forced smile).
- Sharp focus on the face, shallow depth of field on the background.
- Photo-realistic, DSLR quality, no illustration/painting/CGI look, no text or watermark.
`.trim();

const STYLE_PROMPTS = {
  'Executivo(a)': `${IDENTITY_LOCK}

Wardrobe & setting for this version — "Executivo(a)":
- Dress the subject in a well-tailored dark navy or charcoal business suit with a crisp white or
  light blue collared shirt (add a subtle tie only if the subject presents as masculine; a clean
  blouse/blazer combo if feminine).
- Background: a softly blurred modern office environment (glass walls, soft window light, muted
  neutral tones), suggesting an executive/corporate workplace, out of focus (bokeh).
- Lighting: soft, directional studio light from the front-left, gentle fill light to avoid harsh
  shadows, warm-neutral color temperature that conveys authority and trust.`,

  'Corporativo neutro': `${IDENTITY_LOCK}

Wardrobe & setting for this version — "Corporativo neutro":
- Dress the subject in simple, neutral business attire (a plain blazer over a solid-color shirt/blouse,
  no loud patterns), in gray, navy, or black tones.
- Background: a flat, smooth light-gray studio background (seamless paper backdrop look), evenly lit,
  no props, no texture, completely neutral.
- Lighting: even, soft studio lighting typical of corporate ID/LinkedIn photos, minimal shadow, clean
  and simple look.`,

  'Casual elegante': `${IDENTITY_LOCK}

Wardrobe & setting for this version — "Casual elegante":
- Dress the subject in smart-casual attire: a well-fitted knit sweater, or an open-collar shirt without
  a tie, or a casual blazer without a tie — polished but relaxed, no gravata.
- Background: a softly blurred neutral setting with warm, approachable tones (light beige, soft green,
  or warm gray), slightly more relaxed than a corporate office.
- Lighting: soft and warm, slightly more natural-light feeling, approachable and friendly mood while
  still looking professional and high-quality.`,

  'Fundo estúdio': `${IDENTITY_LOCK}

Wardrobe & setting for this version — "Fundo estúdio":
- Dress the subject in clean, simple professional attire appropriate for a studio portrait (solid
  color shirt/blouse or blazer, no busy patterns).
- Background: an infinite seamless studio backdrop in neutral light-gray or off-white, perfectly even,
  classic studio headshot look, no environment or props at all.
- Lighting: classic three-point studio portrait lighting (key, fill, and subtle rim light), crisp and
  polished, similar to professional portrait studio photography.`,

  // ---------------------------------------------------------------------
  // Estilo 5: único estilo extra do pacote "Premium" (order bump). Mesmo
  // IDENTITY_LOCK, só muda guarda-roupa/fundo/luz. O catálogo inteiro tem
  // propositalmente só 5 estilos no total — o bump desbloqueia os outros 4
  // (o conjunto INTEIRO, "pacote completo" de verdade, sem prometer mais
  // do que entrega) sem nunca abrir mão da preservação de identidade que é
  // a promessa central do produto.
  // ---------------------------------------------------------------------

  'Blazer premium': `${IDENTITY_LOCK}

Wardrobe & setting for this version — "Blazer premium":
- Dress the subject in a sharply tailored dark blazer (charcoal or deep navy) over a plain fine-knit
  top or shirt, no tie — an elevated, editorial-premium look.
- Background: a softly blurred upscale modern building facade (glass and steel), out of focus bokeh,
  suggesting a premium urban business setting.
- Lighting: warm directional rim light separating the subject from the background, soft key light
  from the front, premium editorial-portrait feel.`,
};

// ---------------------------------------------------------------------------
// Sessão de estúdio — 5 fotos EXCLUSIVAS do pacote Deluxe Estúdio™.
// Diferença pros estilos do catálogo: aqui variamos POSE e ENQUADRAMENTO
// (não só roupa/fundo), simulando uma sessão de fotos real. Por isso cada
// prompt traz um "Framing override" explícito: a seção de enquadramento do
// IDENTITY_LOCK (busto centralizado, olhando pra câmera) é substituída — a
// parte de preservação de identidade continua valendo integralmente.
// ---------------------------------------------------------------------------
const SESSION_PROMPTS = {
  'Estúdio P&B': `${IDENTITY_LOCK}

Wardrobe & setting for this version — "Estúdio P&B" (black & white studio portrait):
- Convert the final image to rich BLACK AND WHITE (true monochrome, deep blacks, detailed
  midtones, no color cast) — like a classic editorial studio portrait.
- Dress the subject in a dark blazer or elegant dark top, minimal and timeless.
- Background: dark charcoal-to-black seamless studio backdrop with a subtle vignette.
- Lighting: dramatic single key light (Rembrandt style) with soft fill, strong but flattering
  shadows sculpting the face.
Framing override for this session shot (replaces the framing section above):
- Head-and-shoulders, subject turned slightly (about 20 degrees) with the face back toward
  the camera, confident neutral expression, eyes to the lens.`,

  'Mesa do diretor': `${IDENTITY_LOCK}

Wardrobe & setting for this version — "Mesa do diretor" (executive desk):
- Dress the subject in a sharp tailored suit or executive attire.
- Setting: seated at a large dark-wood executive desk in a corner office, softly blurred
  floor-to-ceiling windows and a city skyline behind, warm late-afternoon light.
- Pose: seated, leaning slightly forward with forearms resting on the desk, hands calmly
  clasped, projecting approachable authority.
Framing override for this session shot (replaces the framing section above):
- Waist-up composition showing the desk edge and hands, camera at chest height, subject
  looking directly at the camera with a subtle confident smile.`,

  'Braços cruzados': `${IDENTITY_LOCK}

Wardrobe & setting for this version — "Braços cruzados" (arms crossed, half body):
- Dress the subject in smart business-casual: blazer over a plain shirt/blouse, no tie.
- Background: light-gray seamless studio backdrop, clean and minimal.
- Pose: standing, arms confidently crossed, shoulders relaxed, natural upright posture.
Framing override for this session shot (replaces the framing section above):
- Half-body composition (from just below the elbows up), subject angled about 15 degrees,
  face toward the camera, warm genuine smile, classic corporate-team-page look.`,

  'Perfil editorial': `${IDENTITY_LOCK}

Wardrobe & setting for this version — "Perfil editorial" (side-lit editorial look):
- Dress the subject in an elegant dark turtleneck or minimal dark top (editorial magazine style).
- Background: deep neutral gray studio backdrop with a soft gradient.
- Lighting: strong directional side light from one side, gently wrapping the face, the other
  side falling into soft shadow — sophisticated magazine-profile feel, in color with muted
  cinematic grading.
Framing override for this session shot (replaces the framing section above):
- Head-and-shoulders, subject's body turned about 45 degrees with the face turned back
  toward the camera, thoughtful composed expression.`,

  'Luz de janela': `${IDENTITY_LOCK}

Wardrobe & setting for this version — "Luz de janela" (window light, candid-professional):
- Dress the subject in refined business-casual (open blazer or quality knit).
- Setting: standing beside a large office window with sheer curtains, soft natural daylight
  as the only light source, blurred modern interior behind.
- Pose: relaxed, one shoulder slightly toward the window, natural candid-professional energy.
Framing override for this session shot (replaces the framing section above):
- Chest-up composition, subject looking at the camera with a soft natural smile, gentle
  window light illuminating one side of the face.`,
};

const DEFAULT_STYLE = 'Corporativo neutro';

function getPromptForStyle(styleName) {
  return STYLE_PROMPTS[styleName] || SESSION_PROMPTS[styleName] || STYLE_PROMPTS[DEFAULT_STYLE];
}

// Devolve os outros estilos do catálogo (todos exceto o escolhido).
function getOtherStyles(styleName) {
  return Object.keys(STYLE_PROMPTS).filter((name) => name !== styleName);
}

// ---------------------------------------------------------------------------
// Fotos EXTRAS de cada pacote (além da foto principal no estilo escolhido):
// - inicial: nenhuma (só a foto principal)
// - premium: os outros 3 estilos do seletor ('Blazer premium' fica de fora —
//   é exclusivo do Deluxe, pra escada de valor ter degraus reais)
// - deluxe: os outros 4 do catálogo (incluindo 'Blazer premium') + as 5
//   fotos de sessão de estúdio = 9 extras, 10 fotos no total
// ---------------------------------------------------------------------------
function getExtraStylesForPackage(packageId, chosenStyle) {
  const others = getOtherStyles(chosenStyle);
  if (packageId === 'deluxe') return [...others, ...Object.keys(SESSION_PROMPTS)];
  if (packageId === 'premium') return others.filter((n) => n !== 'Blazer premium').slice(0, 3);
  return [];
}

module.exports = { getPromptForStyle, getOtherStyles, getExtraStylesForPackage, STYLE_PROMPTS, SESSION_PROMPTS, DEFAULT_STYLE };
