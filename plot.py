import datetime, math, os, re, sys, tempfile

import plotly.graph_objects as go
import requests

URL = 'https://www.vedur.is/skjalftar-og-eldgos/jardskjalftar'
OUTPUT = 'index.html'

# Svæði sem er plottað (Reykjanesskagi)
LAT_MIN, LAT_MAX = 63.5, 64.5
LON_MIN, LON_MAX = -23.5, -21.0

# Litaskali fyrir aldur skjálfta, vedur.is sýnir u.þ.b. síðustu 48 klst
MAX_AGE_HOURS = 48

PLACES = [
    (63.845, -22.432, 'Grindavík'),
    (63.866, -22.437, 'Þorbjörn'),
    (63.879, -22.447, 'Bláa Lónið'),
    (63.981, -22.381, 'Vogar'),
    (63.890, -22.269, 'Fagradalsfjall'),
    (63.997, -22.626, 'KEF'),
    (63.925, -21.979, 'Kleifarvatn'),
    (63.800, -22.701, 'Reykjanestá'),
    (64.032, -21.831, 'Búrfell'),
]


def num(s):
    return float(s.replace(',', '.'))


def fetch():
    r = requests.get(URL, timeout=30)
    r.raise_for_status()

    quakes = []
    for m in re.findall(r'\{(.*?)\}', r.text):
        if "'dep'" not in m:
            continue
        fields = dict(re.findall(r"'(\w+)':'(.*?)'", m))
        # JS Date: new Date(2026,10-1,4,15,10,1), mánuðir eru 0-indexed
        d = re.search(r"'t':new Date\((.*?)\)", m).group(1).split(',')
        month = js_month(d[1])
        t = datetime.datetime(int(d[0]), month, *map(int, d[2:6]))
        quakes.append({
            'time': t,
            'latitude': num(fields['lat']),
            'longitude': num(fields['lon']),
            'depth': num(fields['dep']),
            'magnitude': num(fields['s']),
            'place': '%s km %s af %s' % (fields.get('dL', '?'), fields.get('dD', '').strip(), fields.get('dR', '?')),
        })
    return quakes


def js_month(s):
    # '10-1' -> 10 (JS 0-indexed mánuður + 1)
    a, _, b = s.partition('-')
    return int(a) - int(b or 0) + 1


def in_region(q):
    return LAT_MIN < q['latitude'] < LAT_MAX and LON_MIN < q['longitude'] < LON_MAX


def build_figure(quakes):
    # Tímar á vedur.is eru íslenskur tími = UTC
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    ages = [(now - q['time']).total_seconds() / 3600 for q in quakes]

    fig = go.Figure(go.Scatter3d(
        x=[q['longitude'] for q in quakes],
        y=[q['latitude'] for q in quakes],
        z=[q['depth'] for q in quakes],
        mode='markers',
        customdata=[[q['magnitude'], q['time'].strftime('%d/%m %H:%M:%S'), q['place'], age] for q, age in zip(quakes, ages)],
        hovertemplate=(
            '<b>M %{customdata[0]:.1f}</b><br>'
            'Dýpt: %{z:.1f} km<br>'
            '%{customdata[1]} (fyrir %{customdata[3]:.0f} klst)<br>'
            '%{customdata[2]}<br>'
            '%{y:.3f}°N, %{x:.3f}°<extra></extra>'
        ),
        marker=dict(
            sizemode='diameter',
            sizeref=0.2,
            size=[max(q['magnitude'], 0.3) for q in quakes],
            color=ages,
            cmin=0,
            cmax=MAX_AGE_HOURS,
            colorscale='turbo',
            reversescale=True,
            opacity=0.6,
            colorbar=dict(title='Aldur (klst)'),
            line_color='rgb(140, 140, 170)',
        ),
    ))

    # Raunhæft hlutfall: 1° lengdar er styttri en 1° breiddar á 64°N
    km_x = (LON_MAX - LON_MIN) * 111.32 * math.cos(math.radians((LAT_MIN + LAT_MAX) / 2))
    km_y = (LAT_MAX - LAT_MIN) * 111.32
    max_depth = max([10] + [q['depth'] for q in quakes])

    fig.update_layout(
        height=900,
        margin=dict(l=0, r=0, t=0, b=0),
        scene=dict(
            annotations=[dict(x=lon, y=lat, z=0, text=name, showarrow=True, arrowhead=2) for lat, lon, name in PLACES],
            xaxis=dict(title='Lengdargráða', range=[LON_MIN, LON_MAX], ticksuffix='°'),
            yaxis=dict(title='Breiddargráða', range=[LAT_MIN, LAT_MAX], ticksuffix='°'),
            zaxis=dict(title='Dýpt', range=[max_depth, 0], ticksuffix=' km'),
            aspectmode='manual',
            # Dýpt ýkt svo hún sjáist
            aspectratio=dict(x=km_x / km_y, y=1, z=0.4),
            # Horft úr suðri svo norður sé upp og vestur til vinstri
            camera=dict(eye=dict(x=0, y=-1.6, z=1.1)),
        ),
    )
    return fig


def write_page(fig, count):
    now = datetime.datetime.now()
    plot = fig.to_html(full_html=False, include_plotlyjs='cdn', config={'responsive': True})
    html = f'''<!doctype html>
<html>
<head><meta charset="utf-8"><title>Jarðskjálftaplott</title></head>
<body>
<h1>Jarðskjálftar á Reykjanesskaga</h1>
<p>Síðan uppfærist á 5mín fresti. Til að fá nýjustu gögn þarf að refresha. Síðast uppfært kl {now:%d/%m %Y %H:%M} ({count} skjálftar)</p>
<p>Hringir á mynd eru skjálftar og stærð hrings gefur til kynna stærð skjálftans. Litur á hring segir til um aldur skjálftans</p>
{plot}
</body>
</html>
'''
    # Skrifa í tímabundna skrá og færa svo hálfskrifuð síða sé aldrei birt
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(OUTPUT)), suffix='.html')
    with os.fdopen(fd, 'w') as f:
        f.write(html)
    os.chmod(tmp, 0o644)
    os.replace(tmp, OUTPUT)


def main():
    try:
        quakes = fetch()
    except Exception as e:
        print(f'{datetime.datetime.now()} Villa við að sækja gögn: {e}', file=sys.stderr)
        return 1
    if not quakes:
        print(f'{datetime.datetime.now()} Engir skjálftar fundust, er sniðið á vedur.is breytt?', file=sys.stderr)
        return 1

    local = [q for q in quakes if in_region(q)]
    write_page(build_figure(local), len(local))
    print(f'{datetime.datetime.now()} {len(local)}/{len(quakes)} skjálftar á svæði')
    return 0


if __name__ == '__main__':
    sys.exit(main())
