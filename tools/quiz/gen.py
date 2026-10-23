# Генератор вопросов для «Викторины»: python3 tools/quiz/gen.py
import re, random, json, os, glob, subprocess
D = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(D, '..', '..', 'server', 'quiz_data')
rnd = random.Random(20261024)

def norm(s): return re.sub(r'[^0-9a-zа-я]', '', s.lower().replace('ё', 'е'))
def lines(name):
    for l in open(os.path.join(D, name), encoding='utf-8'):
        l = l.strip()
        if l and not l.startswith('#'): yield l

def similar(a, b):
    wa = [w for w in re.split(r'[\s\-(),«»]+', a.lower()) if len(w) >= 5]
    wb = [w for w in re.split(r'[\s\-(),«»]+', b.lower()) if len(w) >= 5]
    return any(x[:5] == y[:5] for x in wa for y in wb)

def pick(correct, pool, k=3, prefer=None):
    cand = [p for p in dict.fromkeys(pool) if norm(p) != norm(correct) and not similar(p, correct)]
    if prefer:
        pc = [p for p in cand if p in prefer]
        if len(pc) >= k: cand = pc
    if len(cand) < k: return None
    return rnd.sample(cand, k)

NUM, CHO = [], []

# ---- числовые из txt ----
for f in sorted(glob.glob(os.path.join(D, 'num*.txt'))):
    for l in lines(os.path.basename(f)):
        p = [x.strip() for x in l.split('|')]
        if len(p) != 4: print('BAD', l); continue
        NUM.append([p[0], p[1], float(p[2]) if '.' in p[2] else int(p[2]), p[3]])

# ---- элементы: порядковый номер ----
EL = ('Водород Гелий Литий Бериллий Бор Углерод Азот Кислород Фтор Неон Натрий Магний Алюминий Кремний Фосфор Сера Хлор Аргон '
      'Калий Кальций Скандий Титан Ванадий Хром Марганец Железо Кобальт Никель Медь Цинк Галлий Германий Мышьяк Селен Бром Криптон '
      'Рубидий Стронций Иттрий Цирконий Ниобий Молибден Технеций Рутений Родий Палладий Серебро Кадмий Индий Олово Сурьма Теллур Иод Ксенон '
      'Цезий Барий Лантан Церий Празеодим Неодим Прометий Самарий Европий Гадолиний Тербий Диспрозий Гольмий Эрбий Тулий Иттербий Лютеций '
      'Гафний Тантал Вольфрам Рений Осмий Иридий Платина Золото Ртуть Таллий Свинец Висмут Полоний Астат Радон Франций Радий Актиний '
      'Торий Протактиний Уран Нептуний Плутоний Америций Кюрий Берклий Калифорний Эйнштейний Фермий Менделевий Нобелий Лоуренсий '
      'Резерфордий Дубний Сиборгий Борий Хассий Мейтнерий Дармштадтий Рентгений Коперниций Нихоний Флеровий Московий Ливерморий Теннессин Оганесон').split()
assert len(EL) == 118, len(EL)
for i, e in enumerate(EL):
    if i < 103 or e in ('Московий', 'Оганесон', 'Флеровий'):
        NUM.append(['Наука', f'Какой порядковый номер у химического элемента «{e}» в таблице Менделеева?', i + 1, 'номер'])

# ---- римские цифры ----
def roman(n):
    r = ''
    for v, s in [(1000,'M'),(900,'CM'),(500,'D'),(400,'CD'),(100,'C'),(90,'XC'),(50,'L'),(40,'XL'),(10,'X'),(9,'IX'),(5,'V'),(4,'IV'),(1,'I')]:
        while n >= v: r += s; n -= v
    return r
for n in [4,9,14,19,24,29,38,40,44,49,59,64,77,89,90,94,99,111,149,199,246,333,399,404,444,499,555,666,707,888,944,999,1066,1147,1240,1380,1453,1492,1612,1703,1799,1812,1861,1905,1917,1945,1961,1969,1991,2024]:
    NUM.append(['Числа', f'Какое число записано римскими цифрами: {roman(n)}?', n, ''])

# ---- математика ----
for n in range(11, 26): NUM.append(['Числа', f'Сколько будет {n} в квадрате?', n * n, ''])
for n in range(3, 11): NUM.append(['Числа', f'Сколько будет {n} в кубе?', n ** 3, ''])
import math
for n in range(4, 9): NUM.append(['Числа', f'Чему равен факториал числа {n} ({n}!)?', math.factorial(n), ''])
for n in range(6, 17): NUM.append(['Числа', f'Сколько будет 2 в степени {n}?', 2 ** n, ''])
for a, b in [(12,12),(15,15),(17,6),(19,7),(23,4),(25,8),(37,3),(99,9),(125,8),(111,9),(48,5),(64,4)]:
    NUM.append(['Числа', f'Сколько будет {a} × {b}?', a * b, ''])
for n in [144, 169, 196, 225, 289, 324, 361, 400, 625, 900, 1024]:
    NUM.append(['Числа', f'Чему равен квадратный корень из {n}?', int(math.isqrt(n)) if math.isqrt(n) ** 2 == n else round(n ** .5), ''])
for n in [10, 15, 20, 25]: NUM.append(['Числа', f'Какое по счёту простое число — {[2,3,5,7,11,13,17,19,23,29,31,37,41,43,47,53,59,61,67,71,73,79,83,89,97][n-1]}?', n, 'место'])
NUM.append(['Числа', 'Сколько простых чисел меньше 100?', 25, 'чисел'])
NUM.append(['Числа', 'Сколько простых чисел меньше 20?', 8, 'чисел'])
NUM.append(['Числа', 'Чему равна сумма чисел от 1 до 100?', 5050, ''])
NUM.append(['Числа', 'Чему равна сумма чисел от 1 до 10?', 55, ''])

# ---- столицы ----
caps = [[x.strip() for x in l.split('|')] for l in lines('capitals.txt')]
allcaps = [c[1] for c in caps]; allcty = [c[0] for c in caps]
for cty, cap, cont in caps:
    same = [c[1] for c in caps if c[2] == cont]
    d = pick(cap, allcaps, prefer=same)
    if d: CHO.append(['География', f'Какой город — столица страны «{cty}»?', cap] + d)
    if norm(cap) != norm(cty):
        d = pick(cty, allcty, prefer=[c[0] for c in caps if c[2] == cont])
        if d: CHO.append(['География', f'Столицей какой страны является {cap}?', cty] + d)
    d = pick({'Америка': 'Америка', 'Океания': 'Океания'}.get(cont, cont), ['Европа', 'Азия', 'Африка', 'Америка', 'Океания'])

# ---- пулы ----
for f in sorted(glob.glob(os.path.join(D, 'pools*.txt'))):
    secs = re.split(r'^## ', open(f, encoding='utf-8').read(), flags=re.M)[1:]
    for sec in secs:
        rows = sec.strip().split('\n')
        meta = {}; pairs = []
        for r in rows[1:]:
            r = r.strip()
            if not r or r.startswith('#'): continue
            m = re.match(r'^(cat|q|r):\s*(.*)$', r)
            if m: meta[m.group(1)] = m.group(2); continue
            k, v = [x.strip() for x in r.split('|', 1)]
            if v == '-' or '… нет' in k or '… нет' in v: continue
            pairs.append((k, v))
        vals = [v for k, v in pairs]; keys = [k for k, v in pairs]
        for k, v in pairs:
            if norm(v) in norm(k) or norm(k) in norm(v): continue
            d = pick(v, vals)
            if d: CHO.append([meta['cat'], meta['q'].replace('{k}', k[0].lower() + k[1:] if ': {k}' in meta['q'] and re.match(r'^[А-Я][а-я]', k) else k), v] + d)
            if 'r' in meta:
                d = pick(k, [kk for kk, vv in pairs if vv != v])
                if d: CHO.append([meta['cat'], meta['r'].replace('{v}', v), k] + d)

# ---- ручные ----
for f in sorted(glob.glob(os.path.join(D, 'choice*.txt'))):
    for l in lines(os.path.basename(f)):
        p = [x.strip() for x in l.split('|')]
        if len(p) != 6 or len(set(x.lower() for x in p[2:])) != 4: print('BAD', l); continue
        CHO.append(p)

# ---- дедуп ----
old = json.loads(subprocess.check_output(['node', '-e', 'console.log(JSON.stringify(require(process.argv[1])))', os.path.join(D, '..', '..', 'server', 'quiz_questions.js')]))
seen = set(norm(q[1]) for q in old)
def dedup(arr):
    out = []
    for q in arr:
        n = norm(q[1])
        if n in seen: continue
        seen.add(n); out.append(q)
    return out
KEEP = ['Форсаж', 'квиддичу', 'Civilization', 'Февральская', 'ABBA', 'белого носорога', 'с мобильного в России', 'чайной ложке',
        'гласных звуков', 'немецком алфавите', '«Хоббит» Питера', '«Оскаров»', 'колец власти было у эльфов', 'Mafia',
        'Великая Отечественная война (округлённо)', 'Оганесон', 'Counter-Strike (соревновательный']
STOP = set('каком сколь какой какая какое году вышел вышла было была обычн округ приме всего'.split())
def stems(s): return set(x[:5] for x in re.findall(r'[а-яa-z0-9]{3,}', s.lower().replace('ё', 'е'))) - STOP
def proper(s): return set(x[:5] for x in re.findall(r'[А-ЯЁA-Z][а-яёa-z]{3,}', s[1:])) - {'Солнц', 'Земли', 'Земле', 'Земля', 'Росси', 'Какой', 'Какая', 'Сколь'}
def fuzzy_dup(q, others, strict=False):
    if any(k in q[1] for k in KEEP): return False
    if strict:
        a, pa = stems(q[1]), proper(q[1])
        return any(p[2] == q[2] and proper(p[1]) == pa and len(a & stems(p[1])) / max(1, min(len(a), len(stems(p[1])))) >= 0.75 for p in others)
    a, pa = stems(q[1]), proper(q[1])
    for p in others:
        if p[2] != q[2]: continue
        if pa & proper(p[1]): return True
        b = stems(p[1])
        if a and b and len(a & b) / min(len(a), len(b)) >= 0.6: return True
    return False
NUM = [q for q in dedup(NUM) if not fuzzy_dup(q, old)]
CHO = dedup(CHO)
# внутри нового набора
_n = []
for q in NUM:
    if not fuzzy_dup(q, _n, True): _n.append(q)
print('fuzzy-internal removed', len(NUM) - len(_n)); NUM = _n
print('num', len(NUM), 'choice', len(CHO))
def dump(name, arr, comment):
    with open(os.path.join(OUT, name), 'w', encoding='utf-8') as fo:
        fo.write(comment + '\nmodule.exports = [\n' + ''.join('  ' + json.dumps(q, ensure_ascii=False) + ',\n' for q in arr) + '];\n')
dump('num.js', NUM, '// Сгенерировано tools/quiz/gen.py. Формат: [тема, вопрос, ответ, единица].')
dump('choice.js', CHO, '// Сгенерировано tools/quiz/gen.py. Формат: [тема, вопрос, верный ответ, неверный, неверный, неверный].')
