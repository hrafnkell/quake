import plotly.graph_objects as go

import pandas as pd

import requests, re, datetime, time

r = requests.get('https://www.vedur.is/skjalftar-og-eldgos/jardskjalftar#view=table')

matches = []
for m in re.findall('\{(.*?)\}',r.text):
    if len(re.findall("'dep'",m)) == 0:
        print('Fann ekki dep')
        continue
    f = {}
    f['depth'] = float(re.findall("'dep':'(.*?)'" ,m)[0].replace(',','.'))
    f['magnitude'] = float(re.findall("'s':'(.*?)'" ,m)[0].replace(',','.'))
    f['latitude'] = float(re.findall("'lat':'(.*?)'" ,m)[0].replace(',','.'))
    f['longitude'] = float(re.findall("'lon':'(.*?)'" ,m)[0].replace(',','.'))
    d = re.findall("'t':new Date\((.*?)\)", m)[0].split(',')
    d[1] = d[1].split('-')[0] # Grípa mánuð
    f['time'] = datetime.datetime(int(d[0]), int(d[1]), int(d[2]), int(d[3]), int(d[4]), int(d[5]))
    matches.append(f)

#matches.append({'depth': 0.0, 'magnitude':1, 'longitude': -22.432, 'latitude': 63.845, 'time': datetime.datetime.now(), 'text': 'Grindavík'})
df = pd.DataFrame(matches)

print(df)
#df = pd.read_csv('/home/keli/Downloads/Ucpf7PgK.csv', header=0)

# Filtera út drasl utan svæðis
#df = df[df['latitude'] > 63.75]
#df = df[df['latitude'] < 64.5]
#df = df[df['longitude'] < -21]
#df = df[df['longitude'] > -23]
#df = df[df['depth'] < 10]

print(datetime.datetime.now())

def color(x):
    #dt = datetime.datetime.strptime(x, '%Y-%m-%dT%H:%M:%S')
    diff = (datetime.datetime.now() - x)
    return diff.seconds // 3600 + diff.days * 24

#df['text'] = 'Dýpi: ' + df['depth']

fig = go.Figure(data=go.Scattergeo(
    scope = 'europe',
    locations = ['Iceland'],
    locationmode = 'country names',
    lon = df['longitude'],
    lat = df['latitude'],
    marker=dict(size=df['magnitude'], sizemode='area')
    ))


#fig = go.Figure(data=go.Scatter3d(
#    x=df['latitude'],
#    y=df['longitude'],
#    z=df['depth'],
#    text=df['time'],
#    mode='markers',
#    marker=dict(
#        sizemode='diameter',
#        sizeref=0.2,
#        size=df['magnitude'],
#        color = list(map(color,df['time'])),
#        colorscale = 'turbo',
#        #text = list(map(textify, df['magnitude'])),
#        reversescale = True,
#        opacity = 0.6,
#        colorbar_title = 'Aldur (klst)',
#        line_color='rgb(140, 140, 170)',
#    )
#))


fig.update_layout(height=1000, width=1000,
                  title_text='Jarðskjálftar á Íslandi',
                  showlegend = True,
                  geo = dict(scope='Iceland')
                  )


#fig.add_annotation(x=63.845, y=-22.432, z=0, text="Grindarvík", showarrow=True, arrowhead=2)

#fig.update_scenes(zaxis_autorange="reversed", xaxis_autorange="reversed")

fig.write_html('bubb.html')

with open('bubb.html') as file:
    filedata = file.read()

now = datetime.datetime.now()
text = '<h1>Jarðskjálftar á Reykjanesskaga</h1>'
text += '<p>Síðan uppfærist á 5mín fresti. Til að fá nýjustu gögn þarf að refresha. Síðast uppfært kl %s</p>' % now.strftime('%d/%m %Y %H:%M')
text += '<p>Hringir á mynd eru skjálftar og stærð hrings gefur til kynna stærð skjálftans. Litur á hring segir til um aldur skjálftans</p>'

filedata = filedata.replace('</head>','<title>Jarðskjálftaplott</title></head>')
filedata = filedata.replace('<body>', '<body>%s' % text)

with open('index.html', 'w') as file:
    file.write(filedata)

#fig.show()
