/* «Кто я?» — подсказки, что спросить. Список подстраивается под уже заданные вопросы и ответы:
   - заданное (из списка или своими словами — узнаём по ключевым словам) пропадает;
   - очевидное убираем: ответили «я из мультфильма — да» → «я из фильма / из книги» уже не нужны;
     «я мужчина — нет» → «я женщина?» не спрашиваем;
   - открываем уточняющие вопросы: «мультфильм — да» → «советский мультфильм?», «Disney?» и т. д.
   window.WhoSugg(qa) → { fresh: [текст…], rest: [текст…] } — fresh — новые уточняющие, их показываем первыми. */
(() => {
  const Y = (a, id) => a[id] === 'yes';
  const N = (a, id) => a[id] === 'no';
  const real = (a) => Y(a, 'real') || N(a, 'fict');
  const fict = (a) => Y(a, 'fict') || N(a, 'real');
  const anySrc = (a) => SRC.some((id) => Y(a, id));
  const SRC = ['film', 'cartoon', 'series', 'book', 'game', 'anime', 'tale'];

  // g — группа: pair — любой ответ закрывает всю группу; one — «да» на один закрывает остальные
  // when — когда вопрос уместен; f — уточняющий (появляется после ответов, показываем первым)
  const L = [
    { id: 'real', t: 'Я реальный человек?', re: /реальн|существ|настоящ/, g: 'real', pair: 1 },
    { id: 'fict', t: 'Я вымышленный персонаж?', re: /вымышл|выдуман|придуман/, g: 'real', pair: 1 },
    { id: 'man', t: 'Я мужчина?', re: /мужчин|парень|мужск/, g: 'sex', pair: 1 },
    { id: 'woman', t: 'Я женщина?', re: /женщин|девушк|женск|девочк/, g: 'sex', pair: 1 },
    { id: 'human', t: 'Я человек?', re: /^я человек|я люд/, when: (a) => !real(a) },
    { id: 'animal', t: 'Я животное?', re: /животн|зверь/, when: (a) => !real(a) && !Y(a, 'human') },
    { id: 'alive', t: 'Я жив сейчас?', re: /жив/, when: (a) => !fict(a) },
    { id: 'famous', t: 'Я знаменит на весь мир?', re: /знамен|известн|популярн/ },

    // откуда персонаж — для вымышленных
    ...[
      ['film', 'Я из фильма?', /(?<!мульт)фильм|кино/],
      ['cartoon', 'Я из мультфильма?', /мульт/],
      ['series', 'Я из сериала?', /сериал/],
      ['book', 'Я из книги?', /книг|роман|литератур/],
      ['game', 'Я из видеоигры?', /игр/],
      ['anime', 'Я из аниме?', /аниме|манг/],
      ['tale', 'Я из сказки?', /сказк/],
    ].map(([id, t, re]) => ({ id, t, re, g: 'src', when: (a) => !real(a) })),
    { id: 'disney', t: 'Я персонаж Disney или Pixar?', re: /disney|дисне|pixar|пиксар/, when: (a) => fict(a) && (Y(a, 'cartoon') || !anySrc(a)), f: 1 },
    { id: 'marvel', t: 'Я персонаж Marvel или DC?', re: /marvel|марвел|dc\b|комикс/, when: (a) => fict(a) && !Y(a, 'cartoon') && !Y(a, 'tale') && !Y(a, 'book'), f: 1 },
    { id: 'hero', t: 'Я супергерой?', re: /супергеро/, when: (a) => fict(a), f: 1 },
    { id: 'villain', t: 'Я злодей?', re: /злоде|плох/, when: (a) => fict(a), f: 1 },
    { id: 'powers', t: 'У меня есть суперсилы или магия?', re: /суперсил|магия|волшеб|сверхспособ/, when: (a) => fict(a), f: 1 },
    { id: 'main', t: 'Я главный герой?', re: /главн/, when: (a) => fict(a), f: 1 },
    // уточнения по источнику
    { id: 'c-ussr', t: 'Я из советского мультфильма?', re: /советск/, when: (a) => Y(a, 'cartoon'), f: 1 },
    { id: 'c-series', t: 'Я из мультсериала?', re: /мультсериал/, when: (a) => Y(a, 'cartoon'), f: 1 },
    { id: 'f-2000', t: 'Фильм вышел после 2000 года?', re: /после 2000|2000/, when: (a) => Y(a, 'film'), f: 1 },
    { id: 'f-fant', t: 'Это фантастика или фэнтези?', re: /фантаст|фэнтез/, when: (a) => Y(a, 'film') || Y(a, 'series') || Y(a, 'book'), f: 1 },
    { id: 'f-many', t: 'У фильма несколько частей?', re: /част|франшиз|сиквел/, when: (a) => Y(a, 'film'), f: 1 },
    { id: 's-com', t: 'Это комедийный сериал?', re: /комеди/, when: (a) => Y(a, 'series'), f: 1 },
    { id: 's-usa', t: 'Это американский сериал?', re: /американ/, when: (a) => Y(a, 'series'), f: 1 },
    { id: 'b-kids', t: 'Это детская книга?', re: /детск/, when: (a) => Y(a, 'book') || Y(a, 'tale'), f: 1 },
    { id: 'b-school', t: 'Это проходят в школе?', re: /школ|классик/, when: (a) => Y(a, 'book'), f: 1 },
    { id: 'g-nin', t: 'Я из игры Nintendo?', re: /nintendo|нинтендо|марио/, when: (a) => Y(a, 'game'), f: 1 },
    { id: 'g-shoot', t: 'Это игра со стрельбой?', re: /стрел|шутер/, when: (a) => Y(a, 'game'), f: 1 },
    { id: 'a-weapon', t: 'У меня есть меч или особое оружие?', re: /меч|оруж/, when: (a) => Y(a, 'anime') || Y(a, 'game'), f: 1 },
    { id: 't-folk', t: 'Я из народной сказки?', re: /народн/, when: (a) => Y(a, 'tale'), f: 1 },
    { id: 't-royal', t: 'Я принц или принцесса?', re: /принц|корол|цар/, when: (a) => Y(a, 'tale') || Y(a, 'cartoon'), f: 1 },

    // реальные люди — откуда и чем знамениты
    ...[
      ['ukr', 'Я из Украины?', /украин/],
      ['usa', 'Я из США?', /сша|америк/],
      ['eu', 'Я из Европы?', /европ/],
    ].map(([id, t, re]) => ({ id, t, re, g: 'cty', when: (a) => !fict(a) })),
    { id: 'old', t: 'Я жил до 1900 года?', re: /1900|давно/, when: (a) => real(a) && !Y(a, 'alive'), f: 1 },
    { id: 'age50', t: 'Мне больше 50 лет?', re: /50 лет|больше \d+ лет|старше/, when: (a) => real(a) && !N(a, 'alive'), f: 1 },
    ...[
      ['actor', 'Я актёр?', /актёр|актер|актрис/],
      ['music', 'Я музыкант или певец?', /музык|певец|певиц|поп|рок/],
      ['sport', 'Я спортсмен?', /спорт/],
      ['politic', 'Я политик?', /полит|президент/],
      ['sci', 'Я учёный или изобретатель?', /учён|учен|изобрет/],
      ['blog', 'Я блогер или ведущий?', /блог|ведущ|ютуб|стрим/],
    ].map(([id, t, re]) => ({ id, t, re, g: 'job', when: (a) => !fict(a) })),
    { id: 'oscar', t: 'Я получал «Оскар»?', re: /оскар/, when: (a) => Y(a, 'actor'), f: 1 },
    { id: 'holly', t: 'Я снимался в Голливуде?', re: /голливуд/, when: (a) => Y(a, 'actor'), f: 1 },
    { id: 'sing', t: 'Я пою?', re: /^я пою|пою\?|поет/, when: (a) => Y(a, 'music'), f: 1 },
    { id: 'rap', t: 'Я рэпер?', re: /рэп|реп/, when: (a) => Y(a, 'music'), f: 1 },
    { id: 'band', t: 'Я из группы?', re: /групп/, when: (a) => Y(a, 'music'), f: 1 },
    { id: 'foot', t: 'Я футболист?', re: /футбол/, when: (a) => Y(a, 'sport'), f: 1 },
    { id: 'box', t: 'Я боксёр?', re: /бокс/, when: (a) => Y(a, 'sport'), f: 1 },
    { id: 'olymp', t: 'Я олимпийский чемпион?', re: /олимп/, when: (a) => Y(a, 'sport'), f: 1 },
    { id: 'pres', t: 'Я был президентом?', re: /президент/, when: (a) => Y(a, 'politic'), f: 1 },
    { id: 'power', t: 'Я сейчас у власти?', re: /власт/, when: (a) => Y(a, 'politic'), f: 1 },
    { id: 'nobel', t: 'Я получал Нобелевскую премию?', re: /нобел/, when: (a) => Y(a, 'sci'), f: 1 },
    { id: 'tube', t: 'Я ютубер или стример?', re: /ютуб|стрим/, when: (a) => Y(a, 'blog'), f: 1 },

    // ---- ещё уточнения после «да» ----
    // кто я по сути
    { id: 'h-adult', t: 'Я взрослый?', re: /взросл/, when: (a) => Y(a, 'human') || real(a), f: 1 },
    { id: 'h-kid', t: 'Я ребёнок или подросток?', re: /ребён|ребен|подрост|дет[ий]/, when: (a) => Y(a, 'human') && !Y(a, 'h-adult'), f: 1 },
    { id: 'm-bald', t: 'Я лысый?', re: /лыс/, when: (a) => Y(a, 'man') || N(a, 'woman'), f: 1 },
    { id: 'm-hair', t: 'У меня длинные волосы?', re: /волос/, when: (a) => Y(a, 'man') || Y(a, 'woman') || N(a, 'man') || N(a, 'woman'), f: 1 },
    { id: 'w-blond', t: 'Я блондинка?', re: /блонд/, when: (a) => Y(a, 'woman') || N(a, 'man'), f: 1 },
    // животные
    { id: 'an-pet', t: 'Я домашнее животное?', re: /домашн/, when: (a) => Y(a, 'animal'), f: 1 },
    { id: 'an-catdog', t: 'Я кошка или собака?', re: /кошк|кот\b|собак|пёс|пес\b/, when: (a) => Y(a, 'animal'), f: 1 },
    { id: 'an-talk', t: 'Я умею говорить?', re: /говор/, when: (a) => Y(a, 'animal'), f: 1 },
    { id: 'an-water', t: 'Я живу в воде?', re: /вод[еау]|море|океан|рыб/, when: (a) => Y(a, 'animal'), f: 1 },
    { id: 'an-pred', t: 'Я хищник?', re: /хищн/, when: (a) => Y(a, 'animal'), f: 1 },
    // жив / умер
    { id: 'al-young', t: 'Мне меньше 40 лет?', re: /40|моложе|молод/, when: (a) => Y(a, 'alive') && real(a), f: 1 },
    { id: 'al-news', t: 'Обо мне часто пишут в новостях?', re: /новост/, when: (a) => Y(a, 'alive') && real(a), f: 1 },
    { id: 'al-xx', t: 'Я умер в XX веке?', re: /xx|20 век|двадцат/, when: (a) => N(a, 'alive') && !fict(a), f: 1 },
    { id: 'al-young-d', t: 'Я умер молодым?', re: /умер.*молод|молод.*умер/, when: (a) => N(a, 'alive') && !fict(a), f: 1 },
    { id: 'fam-kids', t: 'Меня знают даже дети?', re: /знают.*дет|дети.*знают/, when: (a) => Y(a, 'famous'), f: 1 },
    { id: 'fam-film', t: 'Про меня сняли фильм?', re: /сняли|про меня/, when: (a) => Y(a, 'famous') && real(a), f: 1 },
    // фильм
    { id: 'f-oscar', t: 'Фильм получил «Оскар»?', re: /фильм.*оскар|оскар.*фильм/, when: (a) => Y(a, 'film'), f: 1 },
    { id: 'f-horror', t: 'Это хоррор (ужасы)?', re: /ужас|хоррор/, when: (a) => Y(a, 'film') || Y(a, 'game') || Y(a, 'book'), f: 1 },
    { id: 'f-comedy', t: 'Это комедия?', re: /комеди/, when: (a) => Y(a, 'film') || Y(a, 'cartoon'), f: 1 },
    { id: 'f-holly', t: 'Это голливудский фильм?', re: /голливуд/, when: (a) => Y(a, 'film'), f: 1 },
    // мультфильм
    { id: 'c-pixar', t: 'Я из мультфильма Pixar?', re: /pixar|пиксар/, when: (a) => Y(a, 'cartoon') && !N(a, 'disney'), f: 1 },
    { id: 'c-2000', t: 'Мультфильм вышел после 2000 года?', re: /после 2000|2000/, when: (a) => Y(a, 'cartoon'), f: 1 },
    { id: 'c-ussr2', t: 'Я из «Ну, погоди!» или «Простоквашино»?', re: /погоди|простоквашин/, when: (a) => Y(a, 'c-ussr'), f: 1 },
    // сериал
    { id: 's-netflix', t: 'Это сериал Netflix?', re: /netflix|нетфликс/, when: (a) => Y(a, 'series'), f: 1 },
    { id: 's-long', t: 'В сериале больше 5 сезонов?', re: /сезон/, when: (a) => Y(a, 'series'), f: 1 },
    { id: 's-crime', t: 'Это сериал про криминал или полицию?', re: /криминал|полиц|детектив/, when: (a) => Y(a, 'series') || Y(a, 'film') || Y(a, 'book'), f: 1 },
    // книга
    { id: 'b-magic', t: 'В книге есть магия?', re: /магия|волшеб/, when: (a) => Y(a, 'book'), f: 1 },
    { id: 'b-ua', t: 'Это украинская литература?', re: /украинск.*литер|литер.*украин/, when: (a) => Y(a, 'book'), f: 1 },
    { id: 'b-film', t: 'По книге сняли фильм?', re: /экраниз|по книге/, when: (a) => Y(a, 'book'), f: 1 },
    // игра
    { id: 'g-mobile', t: 'Это игра на телефоне?', re: /телефон|мобил/, when: (a) => Y(a, 'game'), f: 1 },
    { id: 'g-90', t: 'Игра вышла до 2000 года?', re: /до 2000|90-х|девяност/, when: (a) => Y(a, 'game'), f: 1 },
    { id: 'g-fight', t: 'Я из файтинга?', re: /файтинг|mortal|мортал|street fighter/, when: (a) => Y(a, 'game'), f: 1 },
    { id: 'g-online', t: 'Это онлайн-игра?', re: /онлайн/, when: (a) => Y(a, 'game'), f: 1 },
    // аниме и сказки
    { id: 'an-big3', t: 'Я из «Наруто», «Ван-Пис» или «Драгонболла»?', re: /наруто|ван-?пис|драгон/, when: (a) => Y(a, 'anime'), f: 1 },
    { id: 'an-ninja', t: 'Я ниндзя или воин?', re: /ниндзя|воин|самур/, when: (a) => Y(a, 'anime') || Y(a, 'game'), f: 1 },
    { id: 't-grimm', t: 'Я из сказки братьев Гримм или Андерсена?', re: /гримм|андерсен/, when: (a) => Y(a, 'tale'), f: 1 },
    { id: 't-ua', t: 'Я из украинской сказки?', re: /украинск.*сказк/, when: (a) => Y(a, 'tale') || Y(a, 't-folk'), f: 1 },
    { id: 't-evil', t: 'Я злой персонаж сказки?', re: /зл[оа]й/, when: (a) => Y(a, 'tale'), f: 1 },
    // супергерои и магия
    { id: 'hr-mask', t: 'Я ношу маску или костюм?', re: /маск|костюм/, when: (a) => Y(a, 'hero') || Y(a, 'marvel') || Y(a, 'villain'), f: 1 },
    { id: 'hr-cape', t: 'У меня есть плащ?', re: /плащ/, when: (a) => Y(a, 'hero'), f: 1 },
    { id: 'vl-world', t: 'Я хочу захватить мир?', re: /захват|мир[ау]?\b/, when: (a) => Y(a, 'villain'), f: 1 },
    { id: 'pw-mage', t: 'Я волшебник или маг?', re: /волшебн|маг\b|колдун|ведьм/, when: (a) => Y(a, 'powers'), f: 1 },
    { id: 'pw-strong', t: 'Моя сила — физическая (сила, скорость)?', re: /физическ|скорост/, when: (a) => Y(a, 'powers') || Y(a, 'hero'), f: 1 },
    { id: 'mn-many', t: 'Про меня есть несколько частей?', re: /несколько част|частей/, when: (a) => Y(a, 'main'), f: 1 },
    // страны
    { id: 'u-war', t: 'Я связан с армией или войной?', re: /арми|войн|военн/, when: (a) => Y(a, 'ukr') || Y(a, 'politic'), f: 1 },
    { id: 'u-kyiv', t: 'Я из Киева?', re: /киев/, when: (a) => Y(a, 'ukr'), f: 1 },
    { id: 'u-ussr', t: 'Я жил в советское время?', re: /советск.*врем|ссср/, when: (a) => Y(a, 'ukr') && real(a), f: 1 },
    { id: 'us-biz', t: 'Я связан с бизнесом или IT?', re: /бизнес|it\b|айти|компан/, when: (a) => Y(a, 'usa') || (real(a) && !anySrc(a)), f: 1 },
    { id: 'eu-uk', t: 'Я из Великобритании?', re: /британ|англи/, when: (a) => Y(a, 'eu'), f: 1 },
    { id: 'eu-fd', t: 'Я из Франции или Германии?', re: /франц|герман/, when: (a) => Y(a, 'eu'), f: 1 },
    { id: 'eu-is', t: 'Я из Италии или Испании?', re: /итали|испан/, when: (a) => Y(a, 'eu'), f: 1 },
    // профессии
    { id: 'ac-hero', t: 'Я играл супергероя?', re: /играл.*супер/, when: (a) => Y(a, 'actor'), f: 1 },
    { id: 'ac-com', t: 'Я снимаюсь в комедиях?', re: /снима.*комед/, when: (a) => Y(a, 'actor'), f: 1 },
    { id: 'mu-en', t: 'Я пою на английском?', re: /английск/, when: (a) => Y(a, 'music') || Y(a, 'sing'), f: 1 },
    { id: 'mu-solo', t: 'Я выступаю соло?', re: /соло/, when: (a) => Y(a, 'music'), f: 1 },
    { id: 'sp-team', t: 'Это командный вид спорта?', re: /командн/, when: (a) => Y(a, 'sport'), f: 1 },
    { id: 'sp-tennis', t: 'Я теннисист?', re: /теннис/, when: (a) => Y(a, 'sport'), f: 1 },
    { id: 'sp-basket', t: 'Я баскетболист?', re: /баскет/, when: (a) => Y(a, 'sport'), f: 1 },
    { id: 'sp-ua', t: 'Я выступал за Украину?', re: /за украин|сборн/, when: (a) => Y(a, 'sport'), f: 1 },
    { id: 'po-ua', t: 'Я украинский политик?', re: /украинск.*полит/, when: (a) => Y(a, 'politic'), f: 1 },
    { id: 'po-us', t: 'Я американский политик?', re: /американск.*полит/, when: (a) => Y(a, 'politic'), f: 1 },
    { id: 'sc-phys', t: 'Я физик?', re: /физик/, when: (a) => Y(a, 'sci'), f: 1 },
    { id: 'bl-tiktok', t: 'Я популярен в TikTok?', re: /tiktok|тикток/, when: (a) => Y(a, 'blog'), f: 1 },
    { id: 'bl-pod', t: 'Я веду подкаст или шоу?', re: /подкаст|шоу/, when: (a) => Y(a, 'blog'), f: 1 },

    // внешность — подходит всем
    { id: 'glasses', t: 'Я ношу очки?', re: /очк/ },
    { id: 'beard', t: 'У меня есть борода или усы?', re: /бород|(^|[^а-я])усы?([^а-я]|$)/, when: (a) => !Y(a, 'woman') && !N(a, 'man') },
    { id: 'hat', t: 'Я ношу шляпу или головной убор?', re: /шляп|кепк|шапк|головн/ },
    { id: 'fly', t: 'Я умею летать?', re: /лета/, when: (a) => !real(a) },
    { id: 'funny', t: 'Я связан с комедией?', re: /комед|смешн|юмор/ },
  ];
  const BY = Object.fromEntries(L.map((x) => [x.id, x]));

  window.WhoSugg = function (qa) {
    // Что уже спросили: точное совпадение с подсказкой или по ключевым словам
    const ans = {};
    const asked = new Set();
    for (const q of qa || []) {
      const text = String(q.text || '').toLowerCase().replace(/ё/g, 'е');
      for (const x of L) {
        if (x.t.toLowerCase().replace(/ё/g, 'е') === text || x.re.test(text)) {
          asked.add(x.id);
          ans[x.id] = q.v || 'idk';
        }
      }
    }
    // Закрытые группы
    const closed = new Set();
    for (const x of L) {
      if (!x.g || !asked.has(x.id)) continue;
      if (x.pair && (ans[x.id] === 'yes' || ans[x.id] === 'no')) closed.add(x.g);
      if (!x.pair && ans[x.id] === 'yes') closed.add(x.g);
    }
    const ok = L.filter((x) => !asked.has(x.id) && !(x.g && closed.has(x.g)) && (!x.when || x.when(ans)));
    const hasAns = Object.keys(ans).length > 0;
    // Свежие уточнения: сначала те, что открылись после последних ответов «да»
    const order = [];
    for (const q of qa || []) {
      const text = String(q.text || '').toLowerCase().replace(/ё/g, 'е');
      const hit = L.find((x) => x.t.toLowerCase().replace(/ё/g, 'е') === text || x.re.test(text));
      if (hit) order.push(hit.id);
    }
    const rank = (x) => {
      for (let i = order.length - 1, k = 0; i >= 0; i--, k++) {
        const without = { ...ans };
        delete without[order[i]];
        if (x.when && !x.when(without)) return k; // уточнение зависит от этого ответа
      }
      return order.length;
    };
    const freshList = hasAns ? ok.filter((x) => x.f).map((x, i) => ({ x, i, r: rank(x) })).sort((a, b) => a.r - b.r || a.i - b.i).map((o) => o.x.t) : [];
    return {
      fresh: freshList,
      rest: ok.filter((x) => !(hasAns && x.f)).map((x) => x.t),
    };
  };
  window.WhoSugg.items = BY;
})();
