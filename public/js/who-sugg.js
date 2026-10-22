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
    return {
      fresh: hasAns ? ok.filter((x) => x.f).map((x) => x.t) : [],
      rest: ok.filter((x) => !(hasAns && x.f)).map((x) => x.t),
    };
  };
  window.WhoSugg.items = BY;
})();
