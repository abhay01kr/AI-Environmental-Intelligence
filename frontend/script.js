'use strict';

const $ = (id) => document.getElementById(id);

const thread = $('thread');
const q = $('q');
const form = $('form');
const themeBtn = $('theme');
const langBtn = $('lang');
const voice = $('voice');
const vstate = $('vstate');
const vtext = $('vtext');
const micBtn = $('mic');
const chips = $('chips');
let emptyState = $('empty');
let aqiTrendChart = null;
let temperatureTrendChart = null;
let pollutionMap = null;
let pollutionMapPoints = null;
let pollutionMapRequestId = 0;
let lastKnownLocation = null;
let environmentRefreshTimer = null;

const configuredApiBase = document.querySelector('meta[name="api-base"]')?.content.trim();
const isLoopbackHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const localBackendBase = `http://${window.location.hostname === 'localhost' ? 'localhost' : '127.0.0.1'}:5000`;
const API_BASE = configuredApiBase || (
  window.location.protocol === 'file:' ||
  (isLoopbackHost && window.location.port !== '5000')
    ? localBackendBase
    : window.location.origin
);
let environmentRequestId = 0;

let answerLanguage = 'auto';
let rec = null;

const ANSWER_LANGUAGES = [
  { code: 'auto', label: 'AUTO', name: 'automatic' },
  { code: 'hi-IN', label: 'HI', name: 'Hindi' },
  { code: 'bho-IN', label: 'BHO', name: 'Bhojpuri' },
  { code: 'en-IN', label: 'EN', name: 'English' }
];

const KEROSENE_TERMS = [
  'kerosene', 'kero', 'mitti ka tel', 'mitti ke tel',
  'मिट्टी का तेल', 'मिट्टी के तेल', 'मिट्टी तेल', 'केरोसिन', 'किरोसिन'
];
const KEROSENE_SOURCE_TERMS = [
  'pollution source', 'source analysis', 'emission source',
  'प्रदूषण का स्रोत', 'प्रदूषण स्रोत', 'स्रोत विश्लेषण'
];
const WEATHER_TERMS = [
  'weather', 'temperature', 'heat', 'garmi', 'hot', 'mausam',
  'मौसम', 'तापमान', 'गर्मी', 'मौसम कैसा'
];

const KB = [
  {
    k: ['aqi', 'air', 'pollution', 'hawa', 'smog'],
    a: 'Air quality is described with the US AQI scale. Higher values mean greater health concern; sensitive groups should take extra care as pollution rises.',
    s: 'General guidance: US AQI categories'
  },
  {
    k: ['climate', 'warming', 'temperature', 'garmi'],
    a: 'Weather describes conditions now; climate is the long-term pattern over many years. A single local temperature reading cannot establish a climate trend.',
    s: 'General guidance: climate and weather'
  },
  {
    k: ['water', 'jal', 'river', 'paani'],
    a: "Only about 3% of Earth's water is fresh, and most of it is frozen or underground. Saving water at home, fixing leaks and reusing grey water for plants are the quickest wins.",
    s: 'Source: UN Water'
  },
  {
    k: ['plastic', 'waste', 'kachra', 'recycle'],
    a: 'Sort waste into wet, dry and hazardous. Dry plastics with a recycling number 1, 2 or 5 are most widely accepted. Avoid single-use bags and bottles first.',
    s: 'Source: UNEP guidance'
  },
  {
    k: ['tree', 'forest', 'ped', 'plant'],
    a: 'Native species are better matched to local conditions and can support local wildlife. Choose trees suited to the available soil and water.',
    s: 'General guidance: native planting and local growing conditions'
  },
  {
    k: ['carbon', 'footprint', 'co2', 'emission'],
    a: 'Transport, home energy, and food are useful areas to examine. The biggest opportunity depends on personal habits and local options.',
    s: 'General guidance: transport, energy, and food choices'
  }
];

const CHIPS = [
  'Is the air safe to jog in today?',
  'How can I cut my carbon footprint?',
  'Why is plastic waste a problem?',
  'Kitne ped lagane chahiye?'
];

function renderSuggestions() {
  CHIPS.forEach((text) => {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.type = 'button';
    btn.textContent = text;
    btn.addEventListener('click', () => ask(text, false));
    chips.appendChild(btn);
  });
}

function addMessage(role, text, source) {
  if (emptyState) {
    emptyState.remove();
    emptyState = null;
  }

  const row = document.createElement('div');
  row.className = 'msg ' + (role === 'u' ? 'u' : 'a');

  const bubble = document.createElement('div');
  bubble.className = 'b';
  bubble.textContent = text;

  if (source) {
    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = source;
    bubble.appendChild(src);
  }

  row.appendChild(bubble);
  thread.appendChild(row);
  thread.scrollTop = thread.scrollHeight;
  return row;
}

function hasTopicTerm(text, terms) {
  return terms.some((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text);
  });
}

function getAQICategory(value) {
  if (value <= 50) return 'Good';
  if (value <= 100) return 'Moderate';
  if (value <= 150) return 'Unhealthy for sensitive groups';
  if (value <= 200) return 'Unhealthy';
  if (value <= 300) return 'Very unhealthy';
  return 'Hazardous';
}

function getAQIHealthGuidance(value) {
  if (value > 300) return 'Avoid outdoor activity; keep indoor air as clean as possible.';
  if (value > 200) return 'Everyone should reduce outdoor exertion; sensitive groups should avoid it.';
  if (value > 150) return 'Everyone should reduce prolonged or heavy outdoor exertion.';
  if (value > 100) return 'Children, older adults, and people with heart or lung conditions should limit prolonged or heavy outdoor exertion.';
  if (value > 50) return 'Sensitive people may want to reduce prolonged or heavy outdoor exertion.';
  return 'Air quality is in the good range; continue checking conditions if you are sensitive to pollution.';
}

function getWeatherAssessment(data) {
  const temperature = isFiniteMeasurement(data.apparent_temperature)
    ? Number(data.apparent_temperature)
    : isFiniteMeasurement(data.temperature)
      ? Number(data.temperature)
      : null;
  const rainChance = isFiniteMeasurement(data.rain_chance)
    ? Number(data.rain_chance)
    : null;
  const wind = isFiniteMeasurement(data.wind) ? Number(data.wind) : null;
  const uv = isFiniteMeasurement(data.uv) ? Number(data.uv) : null;
  const cautions = [];

  if (temperature !== null && temperature >= 35) cautions.push('hot');
  else if (temperature !== null && temperature < 12) cautions.push('cold');
  if (rainChance !== null && rainChance >= 50) cautions.push('rain');
  if (wind !== null && wind >= 30) cautions.push('wind');
  if (uv !== null && uv >= 6) cautions.push('uv');

  const severeConditions =
    (temperature !== null && temperature >= 40) ||
    (rainChance !== null && rainChance >= 75) ||
    (wind !== null && wind >= 45);

  return {
    outlook: severeConditions || cautions.length >= 2
      ? 'caution'
      : cautions.length
        ? 'mixed'
        : 'favorable',
    cautions,
    temperature,
    rainChance,
    wind,
    uv
  };
}

function getEnvironmentContext() {
  const data = window.environmentData;
  const isLive = data && data.source === 'open-meteo';
  const format = (value, digits = 0, unit = '') => isFiniteMeasurement(value)
    ? `${Number(value).toFixed(digits)}${unit}`
    : null;
  const source = isLive
    ? `Live local estimates from Open-Meteo${data.time ? `, updated ${data.time}` : ''}`
    : data
      ? 'Sample conditions only; these are not live measurements for your location'
      : window.environmentDataUnavailable
        ? 'Live local environmental readings are unavailable'
        : 'Local environmental readings are still loading';

  return {
    data,
    isLive,
    source,
    location: isLive && data.city ? data.city : 'your area',
    aqi: data && format(data.aqi),
    temperature: data && format(data.temperature, 1, '°C'),
    feelsLike: data && format(data.apparent_temperature, 1, '°C'),
    uv: data && format(data.uv),
    humidity: data && format(data.humidity, 0, '%'),
    wind: data && format(data.wind, 1, ' km/h'),
    rain: data && format(data.rain_chance, 0, '%'),
    pm25: data && format(data.pm25, 1, ' µg/m³'),
    pm10: data && format(data.pm10, 1, ' µg/m³')
  };
}

function buildContextualAnswer(text) {
  const query = text.toLowerCase().normalize('NFKC');
  const context = getEnvironmentContext();
  const data = context.data;
  const hasLiveAQI = context.isLive && isFiniteMeasurement(data.aqi);
  const hasLiveWeather = context.isLive && isFiniteMeasurement(data.temperature);
  const asksJogging = hasTopicTerm(query, ['jog', 'jogging', 'run', 'running', 'exercise', 'workout', 'walk', 'outside']);
  const asksAQIForecast = hasTopicTerm(query, ['forecast', 'tomorrow', 'next 7 days', 'next week', 'week', 'kal']);
  const asksCurrentConditions = hasTopicTerm(query, ['today', 'now', 'current', 'currently', 'outside', 'weather', 'forecast', 'safe', 'local', 'near me', 'aaj', 'abhi', 'mausam']);
  const asksKerosene = hasTopicTerm(query, KEROSENE_TERMS) ||
    hasTopicTerm(query, KEROSENE_SOURCE_TERMS);
  const topics = [
    {
      id: 'kerosene',
      terms: KEROSENE_TERMS,
      general: 'Kerosene combustion can release fine particles (including PM2.5), carbon monoxide, and nitrogen oxides; sulfur emissions depend in part on the fuel. Emissions vary with the appliance, wick or burner condition, fuel, and ventilation. Use only appliances approved for the intended setting and follow the manufacturer’s operating and ventilation instructions. Never use an outdoor-only appliance indoors, and use a working carbon-monoxide alarm. Local outdoor AQI cannot measure indoor exposure or identify kerosene as its source.'
    },
    {
      id: 'air',
      terms: ['aqi', 'air', 'pollution', 'hawa', 'smog', 'pm2.5', 'pm10', 'jog', 'jogging', 'run', 'running', 'asthma'],
      general: KB[0].a
    },
    {
      id: 'weather',
      terms: WEATHER_TERMS,
      general: 'Weather changes over hours and days. Use current local readings rather than a long-term climate average for decisions today.'
    },
    {
      id: 'climate',
      terms: ['climate', 'warming', 'global warming', 'greenhouse', 'climate change'],
      general: KB[1].a
    },
    {
      id: 'water',
      terms: ['water', 'jal', 'river', 'paani', 'rain', 'rainwater', 'drought', 'paani'],
      general: KB[2].a
    },
    {
      id: 'waste',
      terms: ['plastic', 'waste', 'kachra', 'recycle', 'recycling', 'garbage', 'trash', 'single use'],
      general: KB[3].a
    },
    {
      id: 'forest',
      terms: ['tree', 'trees', 'forest', 'ped', 'plant', 'plants', 'wildlife', 'biodiversity'],
      general: KB[4].a
    },
    {
      id: 'carbon',
      terms: ['carbon', 'footprint', 'co2', 'emission', 'emissions', 'electricity', 'commute', 'fuel'],
      general: KB[5].a
    }
  ];
  const matches = topics.filter((topic) => hasTopicTerm(query, topic.terms));
  const matched = asksKerosene
    ? topics.filter((topic) => topic.id === 'kerosene' || (topic.id === 'air' &&
      hasTopicTerm(query, ['aqi', 'air quality', 'outdoor air', 'outside', 'today', 'now', 'current'])))
    : matches.length ? matches : asksCurrentConditions
    ? [topics[0], topics[1]]
    : [];
  const answers = [];
  const sources = new Set();

  matched.forEach((topic) => {
    if (topic.id === 'kerosene') {
      const asksMitigation = hasTopicTerm(query, ['reduce', 'less', 'prevent', 'avoid', 'protect', 'exposure', 'कम', 'बचाव', 'बचें']);
      const asksFactors = hasTopicTerm(query, ['affect', 'affects', 'impact', 'depend', 'factor', 'factors', 'why', 'असर', 'प्रभाव', 'निर्भर', 'कारण']);
      const asksHealth = hasTopicTerm(query, ['health', 'symptom', 'sick', 'danger', 'harm', 'headache', 'dizzy', 'स्वास्थ्य', 'लक्षण', 'नुकसान', 'खतरा', 'सिरदर्द', 'चक्कर']);
      const answer = asksMitigation
        ? 'To reduce exposure, use only a kerosene appliance approved for indoor use and follow its operating and ventilation instructions. Keep it maintained, ventilate as directed, and use a working carbon-monoxide alarm. If the alarm sounds or anyone develops headache, dizziness, or nausea, everyone should leave immediately and seek emergency help. Never bring an outdoor-only heater or stove indoors.'
        : asksFactors
          ? 'Pollution levels depend on the appliance design and condition, wick or burner adjustment and maintenance, fuel quality, and ventilation. A poorly maintained or incorrectly operated appliance can produce more pollution. Without measurements, the local contribution cannot be quantified.'
          : asksHealth
            ? 'Kerosene smoke can contain fine particles that worsen breathing, and incomplete combustion can produce carbon monoxide (CO), which is colorless, odorless, and potentially fatal. Use a working CO alarm. If it sounds or anyone has headache, dizziness, or nausea, leave immediately and seek emergency help.'
            : topic.general;
      answers.push(answer);
      sources.add('General household air-pollution and carbon-monoxide safety guidance');
    } else if (topic.id === 'air') {
      if (hasLiveAQI) {
        const aqi = Number(data.aqi);
        const category = getAQICategory(aqi);
        let advice = aqi > 200
          ? 'Reduce outdoor exertion; sensitive groups should avoid outdoor activity.'
          : aqi > 150
            ? 'Everyone should reduce prolonged or heavy outdoor exertion.'
            : aqi > 100
              ? 'Children, older adults, and people with heart or lung conditions should limit prolonged or heavy outdoor exertion.'
              : aqi > 50
                ? 'Sensitive people may want to limit prolonged or heavy outdoor exertion.'
                : 'Air quality is in the good range; keep checking if you are sensitive to pollution.';
        if (asksJogging && aqi > 100) {
          advice = aqi > 150
            ? 'I would skip an outdoor run for now; choose an indoor workout or wait for AQI to improve.'
            : 'If you are in a sensitive group, avoid a long or strenuous outdoor run; otherwise consider a shorter, easier workout.';
        } else if (asksJogging) {
          advice = aqi <= 50
            ? 'The AQI is in the good range for outdoor exercise, though personal health and local conditions still matter.'
            : 'Consider an easier or shorter workout, especially if you are sensitive to pollution.';
        }
        answers.push(`In ${context.location}, the current US AQI is ${Math.round(aqi)} (${category}). ${advice}`);
        sources.add('Current AQI: Open-Meteo · health guidance: US AQI categories');
      } else {
        const sampleAQI = data && isFiniteMeasurement(data.aqi)
          ? ` The dashboard's sample AQI is ${Math.round(Number(data.aqi))} (${getAQICategory(Number(data.aqi))}); it is not a live reading for your area.`
          : '';
        answers.push(`${context.source}.${sampleAQI} ${topic.general}`);
        sources.add(context.source);
      }

      if (hasLiveAQI && context.pm25) {
        answers.push(`Measured PM2.5 is ${context.pm25}${context.pm10 ? ` and PM10 is ${context.pm10}` : ''}.`);
      }
      if (asksAQIForecast) {
        const forecast = context.isLive && Array.isArray(data.aqi_forecast)
          ? data.aqi_forecast.filter((day) => day && typeof day.date === 'string')
          : [];
        const forecastSummary = forecast.map((day) => {
          const date = new Date(`${day.date}T12:00:00`);
          const dateLabel = Number.isNaN(date.getTime())
            ? day.date
            : date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
          return isFiniteMeasurement(day.aqi)
            ? `${dateLabel}: ${Math.round(Number(day.aqi))} (${getAQICategory(Number(day.aqi))})`
            : `${dateLabel}: unavailable`;
        });
        answers.push(forecastSummary.length
          ? `Daily maximum US AQI forecast: ${forecastSummary.join(' · ')}.`
          : 'A live AQI forecast is not available in the current data; I will not estimate missing days.');
        sources.add(context.isLive ? 'AQI forecast: Open-Meteo hourly estimates' : context.source);
      }
    } else if (topic.id === 'weather') {
      if (hasLiveWeather) {
        const assessment = getWeatherAssessment(data);
        const readings = [
          context.temperature && `temperature ${context.temperature}`,
          context.feelsLike && `feels like ${context.feelsLike}`,
          context.humidity && `humidity ${context.humidity}`,
          context.uv && `UV ${context.uv}`,
          context.wind && `wind ${context.wind}`,
          context.rain && `rain chance ${context.rain}`
        ].filter(Boolean);
        const outlook = assessment.outlook === 'favorable'
          ? 'Overall, current conditions look generally favorable for routine outdoor plans.'
          : assessment.outlook === 'mixed'
            ? 'Overall, conditions are mixed; take precautions for the weather factors noted.'
            : 'Overall, conditions may be uncomfortable or unsuitable for some outdoor plans; use caution.';
        const precautions = [];
        const feelsLike = isFiniteMeasurement(data.apparent_temperature)
          ? Number(data.apparent_temperature)
          : Number(data.temperature);
        if (feelsLike >= 35) precautions.push('drink water, seek shade, and avoid strenuous activity during peak heat');
        if (Number(data.uv) >= 6) precautions.push('use shade, protective clothing, and sunscreen outdoors');
        const futureWeather = hasTopicTerm(query, ['tomorrow', 'later', 'tonight', 'next week', 'weekend', 'will', 'rahega', 'rhega', 'hoga', 'kal']);
        answers.push(`${outlook} Current weather for ${context.location}: ${readings.join(' · ')}.${precautions.length ? ` Practical steps: ${precautions.join('; ')}.` : ''}${futureWeather ? ' This is a current-conditions reading, not a forecast, so it cannot confirm how the weather will be later.' : ''}`);
        sources.add('Current local weather: Open-Meteo');
      } else if (data && isFiniteMeasurement(data.temperature)) {
        const assessment = getWeatherAssessment(data);
        const feelsLike = isFiniteMeasurement(data.apparent_temperature)
          ? `, feels like ${Number(data.apparent_temperature).toFixed(1)}°C`
          : '';
        const outlook = assessment.outlook === 'favorable'
          ? 'The sample readings suggest generally favorable conditions for routine outdoor plans.'
          : 'The sample readings suggest taking weather precautions.';
        answers.push(`${outlook} Dashboard sample weather: ${Number(data.temperature).toFixed(1)}°C${feelsLike}. These values are not live measurements or a forecast for your area.`);
        sources.add(context.source);
      } else {
        answers.push(`${context.source}. ${topic.general}`);
        sources.add(context.source);
      }
    } else if (topic.id === 'climate') {
      answers.push(topic.general);
      if (hasLiveWeather) {
        answers.push(`For ${context.location}, the current temperature is ${context.temperature}${context.feelsLike ? ` (feels like ${context.feelsLike})` : ''}. This is a local weather reading, not evidence of a long-term climate trend.`);
        sources.add('Current local weather: Open-Meteo');
      } else {
        const sampleTemperature = data && isFiniteMeasurement(data.temperature)
          ? ` Dashboard sample temperature is ${Number(data.temperature).toFixed(1)}°C; it is not a live local reading.`
          : '';
        answers.push(`${context.source}.${sampleTemperature}`);
        sources.add(context.source);
      }
      sources.add(KB[1].s);
    } else if (topic.id === 'water') {
      let answer = KB[2].a;
      if (context.isLive && context.rain) {
        answer += ` The local forecast lists a ${context.rain} chance of rain today; that is a probability, not a rainfall amount.`;
        sources.add('Local precipitation forecast: Open-Meteo');
      } else if (!context.isLive) {
        answer += ` ${context.source}.`;
      }
      answers.push(answer);
      sources.add(KB[2].s);
    } else if (topic.id === 'waste') {
      const mentionsPlastic = hasTopicTerm(query, ['plastic', 'single use']);
      const answer = mentionsPlastic
        ? 'For plastic waste, start by refusing disposable items you do not need, reusing containers, and checking local recycling rules before sorting. Recycling symbols do not guarantee that a local facility accepts an item.'
        : 'Separate food and garden waste, clean dry recyclables, and hazardous waste. Follow your local collection rules; keep batteries and e-waste out of household bins.';
      answers.push(answer);
      sources.add(KB[3].s);
    } else if (topic.id === 'forest') {
      answers.push('Choose locally native trees suited to your soil and water availability, and protect young plants through their first dry seasons. If you share your city or planting area, I can help narrow down suitable species; survival depends on local conditions.');
      sources.add(KB[4].s);
    } else if (topic.id === 'carbon') {
      const actions = [];
      if (hasTopicTerm(query, ['commute', 'travel', 'drive', 'car', 'fuel', 'transport'])) {
        actions.push('compare public transport, shared trips, walking, or cycling for routes where they are practical');
      }
      if (hasTopicTerm(query, ['electricity', 'energy', 'home', 'ac', 'air conditioning'])) {
        actions.push('reduce unnecessary electricity use and choose efficient cooling and appliances');
      }
      if (hasTopicTerm(query, ['food', 'diet', 'meat'])) {
        actions.push('plan meals to reduce food waste and choose more plant-rich meals when practical');
      }
      if (!actions.length) {
        actions.push('start with transport, home energy, and food waste; changes in these areas are practical places to investigate');
      }
      answers.push(`To cut your footprint, ${actions.join('; ')}. The best next step depends on your actual habits—share your commute, home energy, or diet if you want a more personal comparison.`);
      sources.add('Personalized suggestions based on the activities in your question');
    }
  });

  if (!answers.length) {
    if (data && asksCurrentConditions) {
      const readings = [
        context.aqi && `AQI ${context.aqi}`,
        context.temperature && `temperature ${context.temperature}`,
        context.uv && `UV ${context.uv}`,
        context.humidity && `humidity ${context.humidity}`
      ].filter(Boolean);
      answers.push(readings.length
        ? `${context.source}. Available readings: ${readings.join(', ')}. Ask about air quality, weather, water, climate, waste, trees, or carbon for more specific guidance.`
        : `${context.source}. Ask about air quality, weather, water, climate, waste, trees, or carbon.`);
      sources.add(context.source);
    } else {
      answers.push('I can help with air quality, weather, water, climate, waste, trees, and carbon. Ask a question about one of these, or include your location or activity for a more relevant answer.');
    }
  }

  return {
    a: answers.join('\n\n'),
    s: [...sources].join(' · ')
  };
}

function getAnswerLanguage(text) {
  if (answerLanguage !== 'auto') return answerLanguage;
  const query = text.toLowerCase();
  if (hasTopicTerm(query, [
    'bhojpuri', 'bhojpuri me', 'bhojpuri mein', 'भोजपुरी में',
    'का बा', 'का हाल बा', 'रउरा', 'तोहरा', 'हमार', 'काहे', 'का हो', 'बानी',
    'बाड़े', 'बानी', 'कइसन', 'कैसन', 'कइसे', 'होखेला', 'बा', 'का होला',
    'हो सकेला', 'निकल सकेला', 'जरे पर'
  ]) || hasTopicTerm(query, [
    'bhojpuri', 'bhojpuri me', 'bhojpuri mein', 'bhjpouri',
    'ka ba', 'ka haal ba', 'kaise ba', 'kaisan', 'kaisan ba', 'raur', 'raura', 'tohar',
    'hamar', 'bani', 'batawa', 'kaahe', 'baate', 'hola', 'hamni', 'karab',
    'ka hola', 'ho sakela', 'nikal sakela', 'jalela', 'jalawe',
    'mausam badhiya ba', 'mausam theek ba', 'mausam thik ba', 'badhiya ba'
  ])) {
    return 'bho-IN';
  }
  if (hasTopicTerm(query, ['hindi me', 'hindi mein', 'हिंदी में'])) {
    return 'hi-IN';
  }
  if (/[\u0900-\u097f]/.test(text) ||
      hasTopicTerm(query, [
        'kaisa hai', 'kaisi hai', 'kya hai', 'kaise ho', 'batao', 'bataiye',
        'mera', 'meri', 'paani', 'hawa', 'mausam', 'ped', 'aaj', 'abhi',
        'kyun', 'kaise', 'hai', 'hain', 'kya', 'acha', 'accha', 'achha',
        'achchha', 'rahega', 'rhega', 'rahegi', 'rhegi', 'hoga', 'hogi',
        'nahi', 'nahin', 'theek hai', 'thik hai', 'mausam kaisa',
        'weather achha', 'weather acha', 'weather accha'
      ])) {
    return 'hi-IN';
  }
  return 'en-IN';
}

function buildLocalizedAnswer(text, language) {
  const query = text.toLowerCase().normalize('NFKC');
  const context = getEnvironmentContext();
  const data = context.data;
  const isBhojpuri = language === 'bho-IN';
  const topics = [
    { id: 'kerosene', terms: KEROSENE_TERMS },
    { id: 'air', terms: ['aqi', 'air', 'pollution', 'hawa', 'smog', 'pm2.5', 'pm10', 'jog', 'jogging', 'run', 'running', 'asthma', 'हवा', 'प्रदूषण', 'दौड़', 'वायु'] },
    { id: 'weather', terms: WEATHER_TERMS },
    { id: 'climate', terms: ['climate', 'warming', 'global warming', 'greenhouse', 'climate change', 'जलवायु', 'जलवायु परिवर्तन'] },
    { id: 'water', terms: ['water', 'jal', 'river', 'paani', 'rain', 'rainwater', 'drought', 'पानी', 'जल', 'नदी', 'बारिश', 'सूखा'] },
    { id: 'waste', terms: ['plastic', 'waste', 'kachra', 'recycle', 'recycling', 'garbage', 'trash', 'single use', 'प्लास्टिक', 'कचरा', 'रीसाइकिल', 'कूड़ा'] },
    { id: 'forest', terms: ['tree', 'trees', 'forest', 'ped', 'plant', 'plants', 'wildlife', 'biodiversity', 'पेड़', 'पौधा', 'जंगल', 'वन्यजीव'] },
    { id: 'carbon', terms: ['carbon', 'footprint', 'co2', 'emission', 'emissions', 'electricity', 'commute', 'fuel', 'कार्बन', 'उत्सर्जन', 'बिजली'] }
  ];
  const matches = topics.filter((topic) => hasTopicTerm(query, topic.terms));
  const asksKerosene = hasTopicTerm(query, KEROSENE_TERMS) ||
    hasTopicTerm(query, KEROSENE_SOURCE_TERMS);
  const asksCurrentConditions = hasTopicTerm(query, [
    'today', 'now', 'current', 'currently', 'outside', 'weather', 'forecast', 'safe',
    'local', 'near me', 'aaj', 'abhi', 'mausam', 'आज', 'अभी', 'मौसम', 'हाल'
  ]);
  const matched = asksKerosene
    ? topics.filter((topic) => topic.id === 'kerosene' || (topic.id === 'air' &&
      hasTopicTerm(query, ['aqi', 'air quality', 'outdoor air', 'outside', 'today', 'now', 'current', 'वायु गुणवत्ता', 'बाहरी हवा', 'आज', 'अभी'])))
    : matches.length ? matches : asksCurrentConditions
      ? topics.filter((topic) => topic.id === 'air' || topic.id === 'weather')
      : [];
  const hasLiveAQI = context.isLive && isFiniteMeasurement(data.aqi);
  const hasLiveWeather = context.isLive && isFiniteMeasurement(data.temperature);
  const asksJogging = hasTopicTerm(query, ['jog', 'jogging', 'run', 'running', 'exercise', 'workout', 'walk', 'outside', 'दौड़', 'व्यायाम']);
  const answers = [];
  const category = (aqi) => aqi <= 50 ? (isBhojpuri ? 'अच्छा' : 'अच्छा')
    : aqi <= 100 ? (isBhojpuri ? 'ठीक-ठाक' : 'मध्यम')
      : aqi <= 150 ? (isBhojpuri ? 'संवेदनशील लोगन खातिर खराब' : 'संवेदनशील लोगों के लिए अस्वस्थ')
        : aqi <= 200 ? (isBhojpuri ? 'खराब' : 'अस्वस्थ')
          : aqi <= 300 ? (isBhojpuri ? 'बहुत खराब' : 'बहुत अस्वस्थ')
            : (isBhojpuri ? 'खतरनाक' : 'खतरनाक');

  matched.forEach((topic) => {
    if (topic.id === 'kerosene') {
      const asksMitigation = hasTopicTerm(query, ['reduce', 'less', 'prevent', 'avoid', 'protect', 'exposure', 'कम', 'बचाव', 'बचें']);
      const asksFactors = hasTopicTerm(query, ['affect', 'affects', 'impact', 'depend', 'factor', 'factors', 'why', 'असर', 'प्रभाव', 'निर्भर', 'कारण']);
      const asksHealth = hasTopicTerm(query, ['health', 'symptom', 'sick', 'danger', 'harm', 'headache', 'dizzy', 'स्वास्थ्य', 'लक्षण', 'नुकसान', 'खतरा', 'सिरदर्द', 'चक्कर']);
      if (asksMitigation) {
        answers.push(isBhojpuri
          ? 'धूरा से बचे खातिर घर में ओही केरोसिन वाला चूल्हा या हीटर जलाईं जे घर के भीतर इस्तेमाल खातिर मंजूर होखे; ओकर चलावे आ हवा निकाले के हिदायत मानीं। उपकरण के ठीक से रखरखाव करीं आ CO अलार्म लगाईं। अलार्म बाजे, चाहे केहू के माथा दुखे, चक्कर आवे भा जी मिचलाए, त सभे तुरते बाहर निकलीं आ आपात मदद मँगाईं। बाहर वाला चूल्हा-हीटर घर में मत जलाईं।'
          : 'धुएँ से बचने के लिए घर के अंदर केवल उसी केरोसिन चूल्हे या हीटर का उपयोग करें जिसे अंदर चलाने की मंज़ूरी हो; उसके संचालन और वेंटिलेशन निर्देश मानें। उपकरण का रखरखाव करें और CO अलार्म लगाएँ। अलार्म बजे या किसी को सिरदर्द, चक्कर या मतली हो तो सभी लोग तुरंत बाहर जाएँ और आपातकालीन मदद लें। बाहर उपयोग वाला चूल्हा या हीटर घर के अंदर न चलाएँ।');
      } else if (asksFactors) {
        answers.push(isBhojpuri
          ? 'केरोसिन से निकले वाला धूरा उपकरण के बनावट आ हालत, बत्ती या बर्नर के सफाई-रखरखाव, तेल के गुणवत्ता आ घर में हवा निकले के इंतजाम पर निर्भर करेला। बिना माप के ई ना बतावल जा सकेला कि रउआ इलाका के प्रदूषण में केरोसिन के हिस्सा कतना बा।'
          : 'केरोसिन का धुआँ उपकरण की बनावट व हालत, बत्ती या बर्नर की सफाई और रखरखाव, ईंधन की गुणवत्ता तथा हवा के निकास पर निर्भर करता है। माप के बिना यह नहीं बताया जा सकता कि आपके इलाके के प्रदूषण में केरोसिन का कितना योगदान है।');
      } else if (asksHealth) {
        answers.push(isBhojpuri
          ? 'केरोसिन के धूरा में बारीक कण हो सकेला जे साँस के तकलीफ बढ़ा सकेला। अधूरा जरला पर कार्बन मोनोऑक्साइड (CO) बन सकेला; ई बिना रंग-गंध के होला आ जानलेवा हो सकेला। CO अलार्म लगाईं। अलार्म बाजे, चाहे माथा दुखे, चक्कर आवे भा जी मिचलाए, त तुरते बाहर निकलीं आ आपात मदद मँगाईं।'
          : 'केरोसिन के धुएँ में सूक्ष्म कण हो सकते हैं जो साँस की तकलीफ़ बढ़ा सकते हैं। अधूरे दहन से कार्बन मोनोऑक्साइड (CO) बन सकती है; यह रंगहीन और गंधहीन होती है और जानलेवा हो सकती है। CO अलार्म लगाएँ। अलार्म बजे या सिरदर्द, चक्कर या मतली हो तो तुरंत बाहर जाएँ और आपातकालीन मदद लें।');
      } else {
        answers.push(isBhojpuri
          ? 'मिट्टी के तेल जरेला त PM2.5 के बारीक धूरा, कार्बन मोनोऑक्साइड (CO) आ नाइट्रोजन ऑक्साइड हवा में छूट सकेला। सल्फर डाइऑक्साइड कतना बनी, ई तेल में सल्फर के मात्रा पर निर्भर बा। धूरा आ गैस के मात्रा बत्ती/बर्नर के हालत, साफ-सफाई आ घर में हवा के निकास पर बदलत रहेला। रउआ घर में ओही बत्ती, चूल्हा भा हीटर जलाईं जे घर के भीतर चलावे खातिर बनल आ मंजूर होखे; ओकरा बनावे वाला के हिदायत मानीं। बाहर वाला हीटर भा चूल्हा घर में मत जलाईं। CO के रंग-गंध ना होला, बाकिर जान ले सकेला—CO अलार्म लगवले रहीं। अलार्म बाजे, चाहे माथा दुखे, चक्कर आवे भा जी मिचलाए, त सभे जने तुरते खुला हवा में निकलीं आ आपात मदद मँगाईं। बाहर के AQI से घर भीतर के CO के पता ना चलेला, आ ईहो ना पता चलेला कि प्रदूषण केरोसिन से आइल बा।'
          : 'केरोसिन (मिट्टी का तेल) जलाने से PM2.5 जैसे सूक्ष्म कण, कार्बन मोनोऑक्साइड (CO) और नाइट्रोजन ऑक्साइड निकल सकते हैं। सल्फर डाइऑक्साइड की मात्रा ईंधन में सल्फर पर निर्भर करती है। उत्सर्जन उपकरण की बनावट व हालत, रखरखाव, ईंधन और हवा के निकास पर निर्भर करता है। घर के अंदर केवल उसी चूल्हे, हीटर या लैंप का उपयोग करें जिसे अंदर चलाने की मंज़ूरी हो; निर्माता के निर्देश और वेंटिलेशन संबंधी निर्देश मानें। बाहर के उपयोग वाला उपकरण घर के अंदर न चलाएँ। CO रंगहीन और गंधहीन है, लेकिन जानलेवा हो सकता है; CO अलार्म लगाएँ। अलार्म बजे या सिरदर्द, चक्कर, मतली हो तो सभी लोग तुरंत बाहर जाएँ और आपातकालीन मदद लें। बाहरी AQI घर के अंदर के CO को नहीं मापता और प्रदूषण का स्रोत नहीं बताता।');
      }
    } else if (topic.id === 'air') {
      if (hasLiveAQI) {
        const aqi = Math.round(Number(data.aqi));
        let advice;
        if (asksJogging && aqi > 150) {
          advice = isBhojpuri
            ? 'अभी बाहिर दौड़े मत; घर के भीतर कसरत करीं या हवा सुधरे तक रुकीं।'
            : 'अभी बाहर दौड़ने से बचें; घर के अंदर व्यायाम करें या हवा बेहतर होने तक रुकें।';
        } else if (asksJogging && aqi > 100) {
          advice = isBhojpuri
            ? 'दमा या दिल के दिक्कत होखे त बाहर के तेज कसरत से बचीं; बाकी लोग छोट आ हल्का कसरत करीं।'
            : 'दमा या हृदय की समस्या हो तो बाहर तेज़ व्यायाम न करें; अन्य लोग छोटा और हल्का व्यायाम करें।';
        } else if (aqi > 150) {
          advice = isBhojpuri
            ? 'सब लोग बाहिर देर तक या जोरदार मेहनत कम करीं।'
            : 'सभी लोग लंबे समय तक या ज़ोरदार बाहरी गतिविधि कम करें।';
        } else if (aqi > 100) {
          advice = isBhojpuri
            ? 'बच्चा, बुजुर्ग आ दिल या फेफड़ा के मरीज बाहिर के मेहनत कम करीं।'
            : 'बच्चे, बुज़ुर्ग और हृदय या फेफड़ों के मरीज़ बाहरी गतिविधि कम करें।';
        } else if (aqi > 50) {
          advice = isBhojpuri
            ? 'जिनका प्रदूषण से दिक्कत होला, ऊ लोग बाहिर के मेहनत कम कर सकेला।'
            : 'प्रदूषण से संवेदनशील लोग बाहरी गतिविधि कम कर सकते हैं।';
        } else {
          advice = isBhojpuri
            ? 'हवा अभी अच्छा श्रेणी में बा; फिर भी स्थानीय हाल पर नजर रखीं।'
            : 'हवा अभी अच्छी श्रेणी में है; फिर भी स्थानीय स्थिति पर नज़र रखें।';
        }
        answers.push(isBhojpuri
          ? `${context.location} में अभी US AQI ${aqi} (${category(aqi)}) बा। ${advice}`
          : `${context.location} में अभी US AQI ${aqi} (${category(aqi)}) है। ${advice}`);
        if (context.pm25) {
          answers.push(isBhojpuri
            ? `PM2.5 ${context.pm25}${context.pm10 ? ` आ PM10 ${context.pm10}` : ''} मापल गइल बा।`
            : `मापा गया PM2.5 ${context.pm25}${context.pm10 ? ` और PM10 ${context.pm10}` : ''} है।`);
        }
      } else {
        answers.push(isBhojpuri
          ? `${context.source}। नमूना AQI वास्तविक स्थानीय माप ना ह। हवा के गुणवत्ता के चिंता होखे त बाहिर के मेहनत कम करीं।`
          : `${context.source}। नमूना AQI आपके इलाके का वास्तविक माप नहीं है। हवा की गुणवत्ता को लेकर चिंता हो तो बाहरी गतिविधि कम करें।`);
      }
    } else if (topic.id === 'weather') {
      if (hasLiveWeather) {
        const assessment = getWeatherAssessment(data);
        const readings = [
          context.temperature && `तापमान ${context.temperature}`,
          context.feelsLike && `महसूस ${context.feelsLike}`,
          context.humidity && `नमी ${context.humidity}`,
          context.uv && `UV ${context.uv}`,
          context.wind && `हवा ${context.wind}`,
          context.rain && `बारिश की संभावना ${context.rain}`
        ].filter(Boolean).join(' · ');
        const outlook = assessment.outlook === 'favorable'
          ? (isBhojpuri
            ? 'अभी के जानकारी से मौसम आम बाहरी काम खातिर ठीक लागत बा।'
            : 'अभी की जानकारी के आधार पर मौसम सामान्य बाहरी कामों के लिए ठीक लग रहा है।')
          : assessment.outlook === 'mixed'
            ? (isBhojpuri
              ? 'मौसम कुछ ठीक बा, बाकिर नीचे बतावल बात के ध्यान रखीं।'
              : 'मौसम मिला-जुला है; नीचे बताई गई बातों का ध्यान रखें।')
            : (isBhojpuri
              ? 'मौसम में सावधानी रखे के जरूरत बा; बाहर के काम में ध्यान दीं।'
              : 'मौसम में सावधानी की जरूरत है; बाहर की गतिविधियों में ध्यान रखें।');
        const weatherPrecautions = [];
        if (assessment.cautions.includes('hot')) {
          weatherPrecautions.push(isBhojpuri
            ? 'गर्मी बेसी बा, पानी पीअ आ तेज धूप में मेहनत से बचीं'
            : 'गर्मी अधिक है, पानी पिएँ और तेज़ धूप में मेहनत से बचें');
        }
        if (assessment.cautions.includes('cold')) {
          weatherPrecautions.push(isBhojpuri
            ? 'ठंड बा, गरम कपड़ा पहिनीं'
            : 'ठंड है, गरम कपड़े पहनें');
        }
        if (assessment.cautions.includes('rain')) {
          weatherPrecautions.push(isBhojpuri
            ? 'बरखा के संभावना बेसी बा, छाता साथे लीं'
            : 'बारिश की संभावना अधिक है, छाता साथ रखें');
        }
        if (assessment.cautions.includes('wind')) {
          weatherPrecautions.push(isBhojpuri
            ? 'हवा तेज बा, बाहर सावधानी बरतीं'
            : 'हवा तेज़ है, बाहर सावधानी बरतें');
        }
        if (assessment.cautions.includes('uv')) {
          weatherPrecautions.push(isBhojpuri
            ? 'UV तेज बा, छाँव आ धूप से बचाव करीं'
            : 'UV अधिक है, छाया लें और धूप से बचाव करें');
        }
        const futureWeather = hasTopicTerm(query, [
          'tomorrow', 'later', 'tonight', 'next week', 'weekend', 'will',
          'rahega', 'rhega', 'rahegi', 'rhegi', 'hoga', 'hogi', 'kal',
          'आगे', 'कल', 'रहेगा', 'रहेगी', 'होगा', 'होगी'
        ]);
        const futureNote = futureWeather
          ? (isBhojpuri
            ? 'ई अभी के मौसम के जानकारी ह, पूरा आगे के पूर्वानुमान ना; एह से बाद के मौसम पक्का ना कहल जा सकेला।'
            : 'यह अभी की स्थिति है, पूरा भविष्य का पूर्वानुमान नहीं; इसलिए बाद का मौसम निश्चित नहीं बताया जा सकता।')
          : '';
        answers.push(isBhojpuri
          ? `${outlook} ${context.location} के अभी के मौसम: ${readings}.${weatherPrecautions.length ? ` सावधानी: ${weatherPrecautions.join('; ')}।` : ''}${futureNote ? ` ${futureNote}` : ''}`
          : `${outlook} ${context.location} का मौजूदा मौसम: ${readings}.${weatherPrecautions.length ? ` सावधानी: ${weatherPrecautions.join('; ')}।` : ''}${futureNote ? ` ${futureNote}` : ''}`);
      } else if (data && isFiniteMeasurement(data.temperature)) {
        const assessment = getWeatherAssessment(data);
        const outlook = assessment.outlook === 'favorable'
          ? (isBhojpuri
            ? 'नमूना जानकारी से मौसम ठीक लागत बा।'
            : 'नमूना जानकारी के आधार पर मौसम ठीक लग रहा है।')
          : (isBhojpuri
            ? 'नमूना जानकारी से मौसम में सावधानी के जरूरत लागत बा।'
            : 'नमूना जानकारी के आधार पर मौसम में सावधानी की जरूरत लगती है।');
        answers.push(isBhojpuri
          ? `${outlook} नमूना तापमान ${Number(data.temperature).toFixed(1)}°C बा; ई रउरा जगह के लाइव माप या पूर्वानुमान ना ह।`
          : `${outlook} नमूना तापमान ${Number(data.temperature).toFixed(1)}°C है; यह आपके स्थान का लाइव माप या पूर्वानुमान नहीं है।`);
      } else {
        answers.push(isBhojpuri
          ? 'अभी मौसम के लाइव जानकारी नइखे मिलल। कुछ देर बाद फेर कोशिश करीं।'
          : 'मौसम की लाइव जानकारी अभी उपलब्ध नहीं है। कुछ देर बाद फिर कोशिश करें।');
      }
    } else if (topic.id === 'climate') {
      answers.push(isBhojpuri
        ? 'मौसम कुछ घंटा-दिन के हाल होला; जलवायु कई बरिस के औसत पैटर्न होला। एक दिन के तापमान से जलवायु बदलाव साबित ना होला।'
        : 'मौसम कुछ घंटों या दिनों की स्थिति है; जलवायु कई वर्षों का औसत पैटर्न है। एक दिन का तापमान जलवायु परिवर्तन साबित नहीं करता।');
    } else if (topic.id === 'water') {
      answers.push(isBhojpuri
        ? `धरती के पानी में मीठ पानी लगभग 3% बा, आ ओकरो में अधिकतर बर्फ या जमीन के नीचे बा। घर में पानी बचाईं, रिसाव ठीक कराईं आ बाँचल पानी पौधा में इस्तेमाल करीं।${context.isLive && context.rain ? ` आज बारिश के संभावना ${context.rain} बा; ई संभावना ह, बरिसल पानी के मात्रा ना।` : ''}`
        : `पृथ्वी के पानी का लगभग 3% मीठा पानी है, और उसका अधिकतर हिस्सा बर्फ या भूमिगत है। घर में पानी बचाएँ, रिसाव ठीक करें और बचा हुआ पानी पौधों में इस्तेमाल करें।${context.isLive && context.rain ? ` आज बारिश की संभावना ${context.rain} है; यह संभावना है, बारिश की मात्रा नहीं।` : ''}`);
    } else if (topic.id === 'waste') {
      const plastic = hasTopicTerm(query, ['plastic', 'single use', 'प्लास्टिक']);
      answers.push(plastic
        ? (isBhojpuri
          ? 'एक बेर इस्तेमाल होखे वाला प्लास्टिक से बचे के कोशिश करीं, डिब्बा-दउरी फेर इस्तेमाल करीं आ recycling से पहिले अपना शहर के नियम देखीं।'
          : 'एक बार इस्तेमाल होने वाले प्लास्टिक से बचें, डिब्बों का दोबारा उपयोग करें और रीसाइक्लिंग से पहले स्थानीय नियम देखें।')
        : (isBhojpuri
          ? 'गीला कचरा, साफ-सूखा recycling वाला सामान आ खतरनाक कचरा अलग-अलग राखीं। बैटरी आ ई-कचरा आम कूड़ा में मत डालीं।'
          : 'गीला कचरा, साफ़-सूखा रीसाइक्लिंग सामान और खतरनाक कचरा अलग रखें। बैटरी और ई-कचरा सामान्य कूड़े में न डालें।'));
    } else if (topic.id === 'forest') {
      answers.push(isBhojpuri
        ? 'अपना माटी-पानी के हिसाब से स्थानीय पेड़ चुनीं आ नया पौधा के सूखा के मौसम में देखभाल करीं। शहर बताईं त सही प्रजाति सुझावे में मदद करब।'
        : 'मिट्टी और पानी के अनुसार स्थानीय पेड़ चुनें और नए पौधों की सूखे के मौसम में देखभाल करें। अपना शहर बताएँ तो उपयुक्त प्रजाति सुझाने में मदद करूँगा।');
    } else if (topic.id === 'carbon') {
      answers.push(isBhojpuri
        ? 'अपना कार्बन असर घटावे खातिर जहाँ संभव होखे साझा सवारी, बस, पैदल या साइकिल अपनाईं; बिजली बचाईं; आ खाना बरबाद होखे से रोकीं। सबसे बढ़िया कदम रउरा रोज के आदत पर निर्भर बा।'
        : 'कार्बन उत्सर्जन घटाने के लिए जहाँ संभव हो साझा सवारी, बस, पैदल चलना या साइकिल अपनाएँ; बिजली बचाएँ; और भोजन की बर्बादी रोकें। सबसे अच्छा कदम आपकी रोज़मर्रा की आदतों पर निर्भर करता है।');
    }
  });

  if (!answers.length) {
    answers.push(isBhojpuri
      ? 'हम हवा, मौसम, पानी, जलवायु, कचरा, पेड़ आ कार्बन के बारे में मदद कर सकीं। अपना सवाल एह में से कवनो विषय पर पूछीं।'
      : 'मैं हवा की गुणवत्ता, मौसम, पानी, जलवायु, कचरा, पेड़ और कार्बन पर मदद कर सकता हूँ। इनमें से किसी विषय पर सवाल पूछें।');
  }

  return { a: answers.join('\n\n'), s: '' };
}

function localizeAnswerSource(source, language) {
  if (language === 'en-IN' || !source) return source;
  const translations = language === 'bho-IN'
    ? [
      ['Current AQI:', 'अभी के AQI:'],
      ['health guidance:', 'सेहत के सलाह:'],
      ['Current local weather:', 'अभी के स्थानीय मौसम:'],
      ['Local precipitation forecast:', 'स्थानीय बरखा के अनुमान:'],
      ['AQI forecast:', 'AQI के अनुमान:'],
      ['General guidance:', 'आम जानकारी:'],
      ['General household air-pollution and carbon-monoxide safety guidance', 'घर के भीतर के हवा-प्रदूषण आ CO से सुरक्षा के आम सलाह'],
      ['Source:', 'स्रोत:'],
      ['Sample conditions only; these are not live measurements for your location', 'ई नमूना जानकारी ह, रउरा जगह के लाइव माप ना'],
      ['Live local estimates from', 'के लाइव स्थानीय अनुमान']
    ]
    : [
      ['Current AQI:', 'मौजूदा AQI:'],
      ['health guidance:', 'स्वास्थ्य सलाह:'],
      ['Current local weather:', 'स्थानीय मौजूदा मौसम:'],
      ['Local precipitation forecast:', 'स्थानीय वर्षा पूर्वानुमान:'],
      ['AQI forecast:', 'AQI पूर्वानुमान:'],
      ['General guidance:', 'सामान्य जानकारी:'],
      ['General household air-pollution and carbon-monoxide safety guidance', 'घरेलू वायु प्रदूषण और कार्बन मोनोऑक्साइड सुरक्षा की सामान्य सलाह'],
      ['Source:', 'स्रोत:'],
      ['Sample conditions only; these are not live measurements for your location', 'यह केवल नमूना जानकारी है, आपके स्थान का लाइव माप नहीं'],
      ['Live local estimates from', 'की लाइव स्थानीय जानकारी']
    ];
  return translations.reduce(
    (localized, [english, translated]) => localized.replaceAll(english, translated),
    source
  );
}

async function askAI(text) {
  const language = getAnswerLanguage(text);
  const answer = buildContextualAnswer(text);
  const localizedAnswer = language === 'en-IN'
    ? answer
    : buildLocalizedAnswer(text, language);
  return language === 'en-IN'
    ? { ...answer, language }
    : {
      ...localizedAnswer,
      s: localizeAnswerSource(answer.s, language),
      language
    };
}

async function ask(text, voiceMode) {
  text = text.trim();
  if (!text) return;

  addMessage('u', text);
  q.value = '';

  const typing = addMessage('a', '');
  const bubble = typing.firstChild;
  bubble.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';

  try {
    const result = await askAI(text);
    bubble.textContent = result.a;
    if (voiceMode) speakAnswer(result.a, result.language);
    if (result.s) {
      const src = document.createElement('span');
      src.className = 'src';
      src.textContent = result.s;
      bubble.appendChild(src);
    }
  } catch (error) {
    const answerLanguage = getAnswerLanguage(text);
    bubble.textContent = answerLanguage === 'bho-IN'
      ? 'अभी जवाब ना मिल पावल। कृपया फेर से पूछीं।'
      : answerLanguage === 'hi-IN'
        ? 'अभी जवाब नहीं मिल पाया। कृपया फिर से पूछें।'
        : 'I could not answer that right now. Please try again.';
    console.error('AI answer error:', error);
  }

  if (voiceMode && voice) {
    voice.classList.remove('show');
  }
}

function bindTabs() {
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const insights = $('insights');
  const main = $('thread');
  const powerbi = $('powerbi');
  const strip = document.querySelector('.strip');
  const aiInsights = document.querySelector('.ai-insights');
  const analytics = document.querySelector('.analytics');
  const powerbiFrame = powerbi && powerbi.querySelector('iframe');
  const powerbiStatus = $('powerbiStatus');
  const powerbiRefresh = $('powerbi-refresh');

  const loadPowerBI = (reload = false) => {
    if (!powerbiFrame) return;
    const reportUrl = powerbiFrame.dataset.src;
    if (!reportUrl) {
      if (powerbiStatus) powerbiStatus.textContent = 'Power BI report URL is missing.';
      console.error('Power BI report URL is missing from the embed frame.');
      return;
    }

    if (powerbiStatus) {
      powerbiStatus.textContent = reload
        ? 'Reloading Power BI report…'
        : 'Loading Power BI report… Sign in if Microsoft prompts you.';
    }
    if (reload) {
      powerbiFrame.src = 'about:blank';
      window.setTimeout(() => {
        if (powerbiFrame.isConnected) powerbiFrame.src = reportUrl;
      }, 0);
    } else if (!powerbiFrame.getAttribute('src')) {
      powerbiFrame.src = reportUrl;
    }
  };

  if (powerbiFrame) {
    powerbiFrame.addEventListener('load', () => {
      if (!powerbiFrame.getAttribute('src') || powerbiFrame.src === 'about:blank') return;
      if (powerbiStatus) {
        powerbiStatus.textContent = 'Power BI embed page loaded. Report access may require Microsoft sign-in.';
      }
    });
  }

  if (powerbiRefresh) {
    powerbiRefresh.addEventListener('click', () => loadPowerBI(true));
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const isInsights = tab.id === 't-ins';
      const isPowerBI = tab.id === 't-powerbi';
      tabs.forEach((item) => item.setAttribute('aria-selected', String(item === tab)));
      main.hidden = isInsights || isPowerBI;
      insights.hidden = !isInsights;
      powerbi.hidden = !isPowerBI;
      if (strip) strip.hidden = isPowerBI;
      if (aiInsights) aiInsights.hidden = isPowerBI;
      if (analytics) analytics.hidden = isPowerBI;
      if (isPowerBI) {
        loadPowerBI();
        initializePollutionMap();
        window.setTimeout(() => pollutionMap && pollutionMap.invalidateSize(), 0);
      }
    });
  });
}

function getPollutionMapColor(aqi) {
  if (aqi <= 50) return '#16866f';
  if (aqi <= 100) return '#d6aa18';
  if (aqi <= 150) return '#e47d24';
  if (aqi <= 200) return '#c83c43';
  if (aqi <= 300) return '#8e4aa8';
  return '#6b2638';
}

function initializePollutionMap() {
  const mapElement = $('pollutionMap');
  const mapStatus = $('pollutionMapStatus');
  if (!mapElement) return;
  if (typeof window.L === 'undefined') {
    if (mapStatus) mapStatus.textContent = 'Map library could not be loaded. Check your internet connection and reload the page.';
    console.error('Leaflet map library is unavailable.');
    return;
  }

  if (!pollutionMap) {
    const data = window.environmentData;
    const hasLocation = data &&
      isFiniteMeasurement(data.latitude) &&
      isFiniteMeasurement(data.longitude);
    const center = hasLocation
      ? [Number(data.latitude), Number(data.longitude)]
      : [28.6139, 77.2090];
    pollutionMap = window.L.map(mapElement).setView(center, 10);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(pollutionMap);
    pollutionMapPoints = window.L.layerGroup().addTo(pollutionMap);
    bindPollutionMapControls();
    loadPollutionMap(center[0], center[1], hasLocation ? data.city : 'Delhi region');
  }
}

function bindPollutionMapControls() {
  const locateButton = $('pollutionMapLocate');
  const refreshButton = $('pollutionMapRefresh');
  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      const center = pollutionMap.getCenter();
      loadPollutionMap(center.lat, center.lng);
    });
  }
  if (locateButton) {
    locateButton.addEventListener('click', () => {
      if (!navigator.geolocation) {
        $('pollutionMapStatus').textContent = 'Location is unavailable in this browser. Use the map and Refresh map instead.';
        return;
      }

      locateButton.disabled = true;
      $('pollutionMapStatus').textContent = 'Finding your location…';
      navigator.geolocation.getCurrentPosition(
        (position) => {
          locateButton.disabled = false;
          const { latitude, longitude } = position.coords;
          pollutionMap.setView([latitude, longitude], 10);
          loadPollutionMap(latitude, longitude, 'your location');
        },
        (error) => {
          locateButton.disabled = false;
          console.error('Pollution map location lookup failed:', error);
          $('pollutionMapStatus').textContent = error.code === 1
            ? 'Location permission denied. Allow it in your browser settings or move the map and refresh.'
            : 'Could not get your location. Move the map and refresh to view another area.';
        },
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 }
      );
    });
  }
}

async function loadPollutionMap(latitude, longitude, locationName = '') {
  if (!pollutionMap || !pollutionMapPoints) return;
  const mapStatus = $('pollutionMapStatus');
  const requestId = ++pollutionMapRequestId;
  if (mapStatus) mapStatus.textContent = 'Loading live air-quality grid…';

  try {
    const params = new URLSearchParams({
      lat: String(latitude),
      lon: String(longitude)
    });
    const response = await fetch(`${API_BASE}/api/pollution/map?${params}`);
    const result = await response.json();
    if (!response.ok || !result.success || !Array.isArray(result.points)) {
      throw new Error(result.error || `Pollution map API returned ${response.status}`);
    }
    if (requestId !== pollutionMapRequestId) return;

    pollutionMapPoints.clearLayers();
    result.points.forEach((point) => {
      if (!isFiniteMeasurement(point.latitude) ||
          !isFiniteMeasurement(point.longitude) ||
          !isFiniteMeasurement(point.aqi)) return;

      const aqi = Number(point.aqi);
      const marker = window.L.circleMarker(
        [Number(point.latitude), Number(point.longitude)],
        {
          radius: 11,
          color: '#ffffff',
          weight: 2,
          fillColor: getPollutionMapColor(aqi),
          fillOpacity: 0.82
        }
      );
      const popup = document.createElement('div');
      const heading = document.createElement('strong');
      heading.textContent = `US AQI ${aqi} · ${getAQICategory(aqi)}`;
      popup.appendChild(heading);
      [
        ['PM2.5', point.pm25, ' µg/m³'],
        ['PM10', point.pm10, ' µg/m³'],
        ['Updated', point.observed_at, '']
      ].forEach(([label, value, unit]) => {
        if (value === null || value === undefined || value === '') return;
        const line = document.createElement('div');
        line.textContent = `${label}: ${value}${unit}`;
        popup.appendChild(line);
      });
      marker.bindPopup(popup).addTo(pollutionMapPoints);
    });

    if (!result.points.length) {
      throw new Error('No live air-quality readings are available for this area.');
    }
    if (mapStatus) {
      const updatedAt = result.points.find((point) => point.observed_at)?.observed_at;
      const area = locationName ? ` around ${locationName}` : '';
      mapStatus.textContent = `Live ${result.source} model estimates${area} · ${result.points.length} grid points${updatedAt ? ` · updated ${updatedAt}` : ''}. Not station readings.`;
    }
  } catch (error) {
    if (requestId !== pollutionMapRequestId) return;
    console.error('Live pollution map could not be loaded:', error);
    if (mapStatus) mapStatus.textContent = `${error.message} Check that the backend is running, then try Refresh map.`;
  }
}

function toggleTheme() {
  const root = document.documentElement;
  const current = root.getAttribute('data-theme');
  const isDark = current === 'dark';
  root.setAttribute('data-theme', isDark ? 'light' : 'dark');
  themeBtn.textContent = isDark ? 'Dark' : 'Light';
  themeBtn.setAttribute('aria-pressed', String(!isDark));
}

function toggleLanguage() {
  const currentIndex = ANSWER_LANGUAGES.findIndex((language) => language.code === answerLanguage);
  const selectedLanguage = ANSWER_LANGUAGES[(currentIndex + 1) % ANSWER_LANGUAGES.length];
  answerLanguage = selectedLanguage.code;
  langBtn.textContent = selectedLanguage.label;
  langBtn.setAttribute('aria-label', `Answer language: ${selectedLanguage.name}`);
  langBtn.title = selectedLanguage.code === 'auto'
    ? 'Answers follow your question language'
    : `Answer language: ${selectedLanguage.name}`;
  langBtn.setAttribute('aria-pressed', String(answerLanguage !== 'auto'));
}

function renderInsights() {
  const mseg = $('aqiDetail');
  const rseg = $('rseg');
  const poll = $('poll');
  const stats = $('stats');
  const tip = $('tip');
  const dailyForecastGrid = $('week');

  if (!mseg || !rseg || !poll || !stats || !tip || !dailyForecastGrid) return;

  const data = window.environmentData;
  if (!data) {
    mseg.textContent = "Air quality unavailable";
    rseg.textContent = "Weather conditions unavailable";
    stats.innerHTML = [
      '<div class="stat"><strong>PM2.5</strong><span>Unavailable</span></div>',
      '<div class="stat"><strong>Humidity</strong><span>Unavailable</span></div>',
      '<div class="stat"><strong>Temperature</strong><span>Unavailable</span></div>'
    ].join('');
    poll.textContent = "Live pollutant readings are unavailable.";
    tip.textContent = "Allow location access and connect to live data to see current guidance.";
    dailyForecastGrid.replaceChildren();
    const forecastStatus = $('aqiForecastStatus');
    if (forecastStatus) forecastStatus.textContent = "Live AQI forecast unavailable until location data loads.";
    return;
  }
  const aqi = Number(data.aqi);
  const temperature = Number(data.temperature);
  const humidity = Number(data.humidity);
  mseg.textContent = `Air quality: ${Math.round(aqi)}`;
  const rainChance = isFiniteMeasurement(data.rain_chance)
    ? `${Math.round(Number(data.rain_chance))}%`
    : "Unavailable";
  const windSpeed = isFiniteMeasurement(data.wind)
    ? `${Math.round(Number(data.wind))} km/h`
    : "Unavailable";
  rseg.innerHTML = `<div>Rain chance: ${rainChance}</div><div>Wind: ${windSpeed}</div>`;
  stats.innerHTML = [
    `<div class="stat"><strong>PM2.5</strong><span>${isFiniteMeasurement(data.pm25) ? `${Number(data.pm25)} μg/m³` : "Unavailable"}</span></div>`,
    `<div class="stat"><strong>Humidity</strong><span>${Math.round(humidity)}%</span></div>`,
    `<div class="stat"><strong>Temperature</strong><span>${Math.round(temperature)}°C</span></div>`
  ].join('');
  poll.innerHTML = [
    ["PM2.5", data.pm25],
    ["PM10", data.pm10],
    ["CO", data.carbon_monoxide],
    ["NO₂", data.nitrogen_dioxide],
    ["SO₂", data.sulphur_dioxide],
    ["O₃", data.ozone]
  ].map(([name, value]) =>
    `<div class="poll-item"><span>${name}</span><strong>${isFiniteMeasurement(value) ? `${Number(value).toFixed(1)} μg/m³` : "Unavailable"}</strong></div>`
  ).join('');

  const dailyForecast = Array.isArray(data.aqi_forecast)
    ? data.aqi_forecast.filter((day) => day && typeof day.date === "string")
    : [];
  const availableForecast = dailyForecast.filter((day) => isFiniteMeasurement(day.aqi));

  const renderForecastStatus = (elementId, available, requested, label) => {
    const status = $(elementId);
    if (!status) return;
    status.textContent = available
      ? `${label} · Open-Meteo${data.city ? ` for ${data.city}` : ""} · ${available} of ${requested} daily estimates available. Days without provider estimates are omitted.`
      : data.source === "open-meteo"
        ? `${label} is not available for this location right now.`
        : "Use your location to load a live AQI forecast.";
  };
  renderForecastStatus("aqiForecastStatus", availableForecast.length, 7, "Daily maximum US AQI");

  const renderForecastCards = (container, forecast, getLabel) => {
    container.replaceChildren();
    forecast.forEach((item) => {
      const hasAqi = isFiniteMeasurement(item.aqi);
      const aqi = hasAqi ? Number(item.aqi) : null;
      const category = aqi <= 50 ? "Good" : aqi <= 100 ? "Moderate" :
        aqi <= 150 ? "Unhealthy for sensitive groups" : aqi <= 200 ? "Unhealthy" :
          aqi <= 300 ? "Very unhealthy" : "Hazardous";
      const safeCategory = hasAqi ? category : "Unavailable";
      const severity = !hasAqi ? "unavailable" : aqi <= 50 ? "good" : aqi <= 100 ? "moderate" :
        aqi <= 150 ? "sensitive" : aqi <= 200 ? "unhealthy" :
          aqi <= 300 ? "very-unhealthy" : "hazardous";
      const label = getLabel(item);
      const card = document.createElement("div");
      card.className = `week-day aqi-forecast-day aqi-${severity}`;
      const timeLabel = document.createElement("strong");
      timeLabel.textContent = label;
      const value = document.createElement("span");
      value.textContent = hasAqi ? String(Math.round(aqi)) : "—";
      value.setAttribute("aria-label", hasAqi
        ? `AQI forecast ${Math.round(aqi)} at ${label}`
        : "AQI forecast unavailable");
      const categoryLabel = document.createElement("small");
      categoryLabel.textContent = safeCategory;
      card.append(timeLabel, value, categoryLabel);
      container.appendChild(card);
    });
  };
  const formatDate = (value, options) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : date.toLocaleString("en-IN", options);
  };

  renderForecastCards(dailyForecastGrid, availableForecast, (day) =>
    formatDate(`${day.date}T12:00:00Z`, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC"
    }));

  tip.textContent = `${getAQICategory(aqi)}: ${getAQIHealthGuidance(aqi)}`;
}

function bindVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition || !micBtn || !voice || !vstate || !vtext) return;

  micBtn.addEventListener('click', () => {
    if (voice.classList.contains('show')) {
      rec.stop();
      voice.classList.remove('show');
      return;
    }

    rec = new SpeechRecognition();
    rec.lang = answerLanguage === 'bho-IN' || answerLanguage === 'hi-IN'
      ? 'hi-IN'
      : 'en-IN';
    rec.start();
    vstate.textContent = 'Listening';
    vtext.textContent = 'Say your question';
    voice.classList.add('show');

    rec.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      vtext.textContent = transcript;
      voice.classList.remove('show');
      ask(transcript, true);
    };

    rec.onerror = () => {
      vstate.textContent = 'Try again';
      vtext.textContent = 'Voice input is unavailable right now';
    };

    rec.onend = () => {
      if (voice.classList.contains('show')) {
        voice.classList.remove('show');
      }
    };
  });

  const closeBtn = $('vclose');
  const againBtn = $('vagain');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => voice.classList.remove('show'));
  }
  if (againBtn) {
    againBtn.addEventListener('click', () => {
      vstate.textContent = 'Listening';
      vtext.textContent = 'Say your question';
      voice.classList.add('show');
      if (rec) rec.start();
    });
  }
}

function bindForm() {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    ask(q.value, false);
  });

  document.querySelectorAll('.pollution-source-question').forEach((button) => {
    button.addEventListener('click', () => {
      const askTab = $('t-ask');
      if (askTab && askTab.getAttribute('aria-selected') !== 'true') askTab.click();
      ask(button.dataset.question, true);
    });
  });

  const askAbout = $('askabout');
  if (askAbout) {
    askAbout.addEventListener('click', () => {
      ask('What does today\'s environmental data mean for me?', false);
    });
  }
}

renderSuggestions();
bindTabs();
renderInsights();
bindVoice();
bindForm();

if (themeBtn) {
  themeBtn.addEventListener('click', toggleTheme);
  themeBtn.setAttribute('aria-pressed', 'false');
  themeBtn.textContent = 'Dark';
}

if (langBtn) {
  langBtn.addEventListener('click', toggleLanguage);
  langBtn.setAttribute('aria-pressed', 'false');
  langBtn.setAttribute('aria-label', 'Answer language: automatic');
  langBtn.title = 'Answers follow your question language';
  langBtn.textContent = 'AUTO';
}

if (voice) {
  voice.classList.remove('show');
}

if (q) {
  q.focus();
}


async function loadEnvironmentData(url = `${API_BASE}/api/environment`) {
    const requestId = ++environmentRequestId;
    const hasLiveData = window.environmentData?.source === "open-meteo";
    if (!hasLiveData) {
        const riskValue = document.getElementById("riskScoreValue");
        if (riskValue) riskValue.textContent = "…";

        const riskLevelValue = document.getElementById("riskLevelValue");
        if (riskLevelValue) riskLevelValue.textContent = "Loading";

        const predictedAqiElement = document.getElementById("predictedAqiValue");
        if (predictedAqiElement) predictedAqiElement.textContent = "--";
        const predictionStatus = document.getElementById("predictionStatus");
        if (predictionStatus) predictionStatus.textContent = "Loading environmental data...";

        updateAIInsights(null, 'loading');
    }
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Environment API returned ${response.status}`);
        }

        const data = await response.json();
        if (data.source !== "open-meteo") {
            throw new Error("Environment API did not return live provider data");
        }
        if (![data.aqi, data.temperature, data.uv, data.humidity].every(isFiniteMeasurement)) {
            throw new Error('Environment API response is missing valid AQI, temperature, UV, or humidity data');
        }

        if (requestId !== environmentRequestId) return null;
        await applyEnvironmentData(data, 'live', requestId);
        console.log("Environment data:", data);
        return data;
    } catch (error) {
        if (requestId !== environmentRequestId) return null;
        console.error("Backend connection error:", error);
        if (window.environmentData?.source === "open-meteo") {
            const message = `Automatic live refresh failed. Showing the last successful update from ${window.environmentData.time || "an earlier time"}; retrying automatically.`;
            const conditionsSource = document.getElementById("conditionsSource");
            if (conditionsSource) conditionsSource.textContent = message;
            if (locationStatus) locationStatus.textContent = message;
            return null;
        }
        showUnavailableEnvironment(
            `Live data could not be loaded from ${API_BASE}. Check that the backend is running and location access is allowed.`
        );
        return null;
    }
}

function showUnavailableEnvironment(message) {
    window.environmentDataUnavailable = true;
    window.environmentData = null;
    renderInsights();
    const values = {
        aqiValue: "--",
        aqiLabel: "Live air-quality data unavailable",
        temperatureValue: "--",
        feelsLikeValue: "--",
        uvValue: "--",
        uvLabel: "Live UV data unavailable",
        co2Value: "--",
        co2Label: "CO₂ data unavailable",
        conditionsSource: "Live local environmental data unavailable. Allow location access and retry.",
        aiInsightText: message,
        riskScoreValue: "--",
        riskLevelValue: "Unavailable",
        predictedAqiValue: "--",
        predictionStatus: "Live prediction unavailable until current environmental data loads"
    };
    for (const [id, text] of Object.entries(values)) {
        const element = document.getElementById(id);
        if (element) element.textContent = text;
    }
    const attribution = document.getElementById("conditionsAttribution");
    if (attribution) attribution.hidden = true;
    updatePollutionAlerts(null, "unavailable");
    renderEnvironmentalCharts({}, "unavailable");
    const locationMessage = document.getElementById("locationStatus");
    if (locationMessage) locationMessage.textContent = message;
}

function isFiniteMeasurement(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

async function applyEnvironmentData(data, dataStatus, requestId) {
    window.environmentDataUnavailable = false;
    window.environmentData = data;
    renderInsights();

    const aqiValue = document.getElementById("aqiValue");
    if (aqiValue) aqiValue.textContent = Math.round(data.aqi);
    const aqiLabel = document.getElementById("aqiLabel");
    if (aqiLabel) {
        const aqi = Number(data.aqi);
        const category = aqi <= 50 ? "good" : aqi <= 100 ? "moderate" :
            aqi <= 150 ? "unhealthy for sensitive groups" : aqi <= 200 ? "unhealthy" :
                aqi <= 300 ? "very unhealthy" : "hazardous";
        aqiLabel.textContent = `Air quality, ${category} · US AQI`;
    }

    const temperatureValue = document.getElementById("temperatureValue");
    if (temperatureValue) temperatureValue.textContent = `${Math.round(data.temperature)}°`;

    const feelsLikeValue = document.getElementById("feelsLikeValue");
    if (feelsLikeValue) {
        const feelsLike = data.apparent_temperature ?? data.temperature;
        feelsLikeValue.textContent = `${Math.round(feelsLike)}°`;
    }

    const uvValue = document.getElementById("uvValue");
    const hasDailyUvMax = isFiniteMeasurement(data.uv_max);
    const displayedUv = hasDailyUvMax ? Number(data.uv_max) : Number(data.uv);
    if (uvValue) uvValue.textContent = isFiniteMeasurement(displayedUv) ? Math.round(displayedUv) : "--";
    const uvLabel = document.getElementById("uvLabel");
    const uvCategory = displayedUv < 3 ? "low" : displayedUv < 6 ? "moderate" : displayedUv < 8 ? "high" :
        displayedUv < 11 ? "very high" : "extreme";
    if (uvLabel) uvLabel.textContent = hasDailyUvMax
        ? `Today's maximum UV index, ${uvCategory}`
        : `Current UV index, ${uvCategory}`;

    const co2Value = document.getElementById("co2Value");
    if (co2Value) co2Value.textContent = isFiniteMeasurement(data.co2) ? Math.round(data.co2) : "--";
    const co2Label = document.getElementById("co2Label");
    if (co2Label) {
        co2Label.textContent = isFiniteMeasurement(data.co2)
            ? data.source === "sample"
                ? "Sample CO₂ reference, ppm"
                : `Global CO₂ monthly avg, ppm${data.co2_time ? ` · ${data.co2_time}` : ""} · NOAA`
            : "Global CO₂ data unavailable";
    }

    const conditionsSource = document.getElementById("conditionsSource");
    const conditionsAttribution = document.getElementById("conditionsAttribution");
    if (conditionsAttribution) conditionsAttribution.hidden = data.source !== "open-meteo";
    if (conditionsSource) {
        const locationText = (location) => location &&
            isFiniteMeasurement(location.latitude) && isFiniteMeasurement(location.longitude)
            ? `${Number(location.latitude).toFixed(4)}, ${Number(location.longitude).toFixed(4)}`
            : "unavailable";
        const timeText = data.time === data.air_quality_time
            ? (data.time || "time unavailable")
            : `weather ${data.time || "time unavailable"}, air quality ${data.air_quality_time || "time unavailable"}`;
        conditionsSource.textContent = data.source === "open-meteo"
            ? `Open-Meteo modeled estimates, not station measurements · weather grid ${locationText(data.weather_grid_location)} · air-quality grid ${locationText(data.air_quality_grid_location)} · ${timeText}.`
            : "Live environmental data unavailable.";
    }

    renderEnvironmentalCharts(data, dataStatus);

    const riskValue = document.getElementById("riskScoreValue");
    if (riskValue) riskValue.textContent = "…";

    const riskLevelValue = document.getElementById("riskLevelValue");
    if (riskLevelValue) riskLevelValue.textContent = "Calculating";

    updateAIInsights(data, dataStatus, null, true);
    void predictAQI(data, requestId, dataStatus);
    await loadRiskData(data, dataStatus, requestId);
}

async function loadRiskData(data, dataStatus, requestId) {

    try {
        const response = await fetch(
            `${API_BASE}/api/risk`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    aqi: data.aqi,
                    temperature: data.temperature,
                    uv: data.uv,
                    humidity: data.humidity
                })
            }
        );

        if (!response.ok) {
            throw new Error(`Risk API returned ${response.status}`);
        }

        const result = await response.json();
        if (requestId !== environmentRequestId) return;
        console.log("Risk Data:", result);
        console.log("Risk details:", result.data);

        const risk = result.data;
        if (!result.success || !risk || !isFiniteMeasurement(risk.risk_score) ||
            Number(risk.risk_score) < 0 || Number(risk.risk_score) > 100 || !risk.risk_level) {
            throw new Error(result.error || "Risk API returned an invalid risk assessment");
        }

        const riskValue = document.getElementById("riskScoreValue");
        if (riskValue) riskValue.textContent = `${Math.round(Number(risk.risk_score))}/100`;

        const riskLevelValue = document.getElementById("riskLevelValue");
        if (riskLevelValue) riskLevelValue.textContent = risk.risk_level;

        updateAIInsights(data, dataStatus, risk);
    } catch (error) {
        if (requestId !== environmentRequestId) return;
        console.error("Risk API Error:", error);
        const riskValue = document.getElementById("riskScoreValue");
        if (riskValue) riskValue.textContent = "--";

        const riskLevelValue = document.getElementById("riskLevelValue");
        if (riskLevelValue) riskLevelValue.textContent = "Unavailable";

        updateAIInsights(data, dataStatus, null);
    }
}

//  AI TEXT TO SPEECH


function speakAnswer(text, language = 'en-IN') {

    if (!("speechSynthesis" in window)) {
        console.log("Speech synthesisnot supported");
        return;
    }

    // Stop previous speech
    window.speechSynthesis.cancel();

    const speech = new SpeechSynthesisUtterance(text);

    const voices = window.speechSynthesis.getVoices();
    const languageVoice = voices.find((voice) => voice.lang.toLowerCase() === language.toLowerCase()) ||
      (language === 'bho-IN'
        ? voices.find((voice) => voice.lang.toLowerCase().startsWith('hi-in'))
        : null);
    speech.lang = languageVoice ? languageVoice.lang : language;
    if (languageVoice) speech.voice = languageVoice;
    speech.rate = 0.95;
    speech.pitch = 1;

    window.speechSynthesis.speak(speech);
}



const locationBtn = document.getElementById("locationBtn");
const locationStatus = document.getElementById("locationStatus");

function requestLocationEnvironment() {
  if (!navigator.geolocation) {
    if (window.environmentData?.source !== "open-meteo") {
      showUnavailableEnvironment("Location is unavailable in this browser or page context. Open the website on localhost or HTTPS.");
    }
    return false;
  }

  locationStatus.textContent = "📍 Requesting location access to load local environmental data...";
  locationBtn.disabled = true;

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;
      lastKnownLocation = { lat, lon };
      if (!environmentRefreshTimer) {
        environmentRefreshTimer = window.setInterval(() => {
          if (!lastKnownLocation) return;
          const params = new URLSearchParams({
            lat: String(lastKnownLocation.lat),
            lon: String(lastKnownLocation.lon)
          });
          void loadEnvironmentData(`${API_BASE}/api/environment?${params}`);
        }, 15 * 60 * 1000);
      }

      try {
        locationStatus.textContent = "📍 Location found. Loading local weather and air quality...";
        const params = new URLSearchParams({ lat: String(lat), lon: String(lon) });
        const data = await loadEnvironmentData(`${API_BASE}/api/environment?${params}`);
        if (!data) return;

        const city = data.city || "Your area";
        const accuracy = Number.isFinite(position.coords.accuracy)
          ? ` · GPS accuracy about ±${Math.round(position.coords.accuracy)} m`
          : "";
        const formattedLocation = `${city} • ${lat.toFixed(4)}, ${lon.toFixed(4)}${accuracy}`;
        locationStatus.textContent = data.source === "open-meteo"
          ? `📍 ${formattedLocation} · Open-Meteo model-grid estimates, not station readings.`
          : `📍 ${formattedLocation} · ${data.message || "Live data unavailable; showing sample conditions."}`;
        if (pollutionMap && data.source === "open-meteo") {
          pollutionMap.setView([lat, lon], 10);
          loadPollutionMap(lat, lon, city);
        }
      } catch (error) {
        console.error("Location environment update failed:", error);
        showUnavailableEnvironment("Could not load live environmental data for this location. Please try again.");
      } finally {
        locationBtn.disabled = false;
      }
    },
    (error) => {
      console.error(error);
      const hasLiveData = window.environmentData?.source === "open-meteo";
      let message;
      if (error.code === 1) {
        message = "❌ Location permission denied. Allow location access in your browser and use this page on localhost or HTTPS.";
      } else if (error.code === 2) {
        message = "❌ Your current location is unavailable. Check your device location settings.";
      } else if (error.code === 3) {
        message = "❌ Location request timed out. Please try again.";
      } else {
        message = "❌ Could not get your location. Please try again.";
      }
      if (hasLiveData) {
        locationStatus.textContent = `${message} Keeping the last successful live readings.`;
      } else {
        locationStatus.textContent = message;
        showUnavailableEnvironment(message);
      }
      locationBtn.disabled = false;
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 }
  );
  return true;
}

locationBtn.addEventListener("click", requestLocationEnvironment);

if (!requestLocationEnvironment()) {
  console.warn("Automatic location lookup is unavailable; live environmental data cannot be shown.");
}

// AI ENVIRONMENTAL INSIGHTS
function updatePollutionAlerts(data, dataStatus) {
    const status = $("pollutionAlertStatus");
    const message = $("pollutionAlertText");
    if (!status || !message) return;

    if (dataStatus === "loading" || !data || !isFiniteMeasurement(data.aqi)) {
        status.textContent = dataStatus === "unavailable"
            ? "Live air-quality data unavailable"
            : "Waiting for current air-quality data...";
        status.dataset.level = "unavailable";
        message.textContent = "An AQI-based alert cannot be shown until a valid reading is available.";
        return;
    }

    const aqi = Number(data.aqi);
    let level;
    let guidance;
    if (aqi <= 50) {
        level = "Good";
        guidance = "Air quality is in the good range. Continue monitoring if you are sensitive to pollution.";
    } else if (aqi <= 100) {
        level = "Moderate";
        guidance = "Sensitive people may want to reduce prolonged or heavy outdoor exertion.";
    } else if (aqi <= 150) {
        level = "Unhealthy for sensitive groups";
        guidance = "Children, older adults, and people with heart or lung conditions should limit prolonged or heavy outdoor exertion.";
    } else if (aqi <= 200) {
        level = "Unhealthy";
        guidance = "Everyone should reduce prolonged or heavy outdoor exertion; sensitive groups should avoid it.";
    } else if (aqi <= 300) {
        level = "Very unhealthy";
        guidance = "Everyone should reduce outdoor activity and keep indoor air as clean as possible.";
    } else {
        level = "Hazardous";
        guidance = "Avoid outdoor activity and keep indoor air as clean as possible.";
    }

    const isSample = dataStatus === "sample" || dataStatus === "fallback";
    status.dataset.level = level.toLowerCase().replace(/\s+/g, "-");
    status.textContent = `${isSample ? "Sample alert" : "Current air-quality alert"} · AQI ${Math.round(aqi)} · ${level}`;
    message.textContent = `${guidance}${isSample
        ? " These sample values are not measurements for your location."
        : " This alert is based on the overall AQI; it does not identify a specific pollution source."}`;
}

function updateAIInsights(data, dataStatus = 'live', risk = null, riskPending = false) {
    const insight = document.getElementById("aiInsightText");
    if (!insight) return;

    if (dataStatus === "loading") {
        updatePollutionAlerts(data, dataStatus);
        insight.textContent = "Loading current environmental conditions and calculating risk…";
        return;
    }
    updatePollutionAlerts(data, dataStatus);

    const format = (value, digits = 0, unit = "") => isFiniteMeasurement(value)
        ? `${Number(value).toFixed(digits)}${unit}`
        : null;
    const aqi = Number(data.aqi);
    const uv = Number(data.uv);
    const temperature = Number(data.temperature);
    const apparentTemperature = isFiniteMeasurement(data.apparent_temperature)
        ? Number(data.apparent_temperature)
        : temperature;
    const aqiCategory = aqi <= 50 ? "Good" : aqi <= 100 ? "Moderate" :
        aqi <= 150 ? "Unhealthy for sensitive groups" : aqi <= 200 ? "Unhealthy" :
            aqi <= 300 ? "Very unhealthy" : "Hazardous";
    const messages = [
        `Current conditions${data.city ? ` for ${data.city}` : ""}${data.time ? ` · ${data.time}` : ""}`,
        `AQI: ${Math.round(aqi)} (${aqiCategory}, US AQI scale).`
    ];

    messages.push(`Health guidance: ${getAQIHealthGuidance(aqi)}`);

    const weatherReadings = [
        format(data.temperature, 1, "°C") && `temperature ${format(data.temperature, 1, "°C")}`,
        format(data.apparent_temperature, 1, "°C") && `feels like ${format(data.apparent_temperature, 1, "°C")}`,
        format(data.humidity, 0, "%") && `humidity ${format(data.humidity, 0, "%")}`,
        format(data.uv, 0) && `UV ${format(data.uv, 0)}`,
        format(data.wind, 1, " km/h") && `wind ${format(data.wind, 1, " km/h")}`,
        format(data.rain_chance, 0, "%") && `rain chance ${format(data.rain_chance, 0, "%")}`
    ].filter(Boolean);
    if (weatherReadings.length) messages.push(`Weather readings: ${weatherReadings.join(" · ")}.`);

    const pollutantReadings = [
        ["PM2.5", data.pm25, "µg/m³"],
        ["PM10", data.pm10, "µg/m³"],
        ["NO₂", data.nitrogen_dioxide ?? data.no2, "µg/m³"],
        ["SO₂", data.sulphur_dioxide ?? data.so2, "µg/m³"],
        ["O₃", data.ozone ?? data.o3, "µg/m³"]
    ].filter(([, value]) => isFiniteMeasurement(value))
        .map(([name, value, unit]) => `${name} ${format(value, 1, ` ${unit}`)}`);
    if (pollutantReadings.length) {
        messages.push(`Measured pollutants: ${pollutantReadings.join(" · ")}.`);
    }

    const precautions = [];
    if (apparentTemperature >= 35) {
        precautions.push("feels-like temperature is at least 35°C; drink water, seek shade, and avoid strenuous activity during the hottest part of the day");
    }
    if (uv >= 3) {
        precautions.push(uv >= 6
            ? "UV is high; use shade, protective clothing, and sunscreen outdoors"
            : "use sun protection during extended time outdoors");
    }
    if (precautions.length) messages.push(`Practical steps: ${precautions.join("; ")}.`);

    if (risk) {
        messages.push(`App environmental risk indicator: ${risk.risk_level} (${Math.round(Number(risk.risk_score))}/100). This is a rule-based guidance score, not an official health measurement.`);
    } else if (riskPending) {
        messages.push("App environmental risk indicator is being calculated.");
    } else {
        messages.push("App environmental risk indicator is temporarily unavailable.");
    }

    if (dataStatus === "sample" || dataStatus === "fallback") {
        messages.push(dataStatus === "fallback"
            ? "Data note: live data could not be loaded; these are sample values, not measurements for your location."
            : "Data note: these are sample values, not live measurements for your location.");
    } else {
        messages.push(`Data source: ${data.source === "open-meteo" ? "Open-Meteo local estimates" : "environment service"}${data.time ? `, updated ${data.time}` : ""}. Missing pollutant readings are not reported; they are not treated as zero.`);
    }

    insight.textContent = messages.join("\n");
}

// ENVIRONMENTAL ANALYTICS CHARTS
function renderEnvironmentalCharts(data, dataStatus) {
    const aqiCanvas = document.getElementById("aqiChart");
    const temperatureCanvas = document.getElementById("temperatureChart");
    const aqiCaption = document.getElementById("aqiChartCaption");
    const temperatureCaption = document.getElementById("temperatureChartCaption");

    if (!aqiCanvas || !temperatureCanvas) return;
    if (typeof Chart === "undefined") {
        if (aqiCaption) aqiCaption.textContent = "Chart library unavailable.";
        if (temperatureCaption) temperatureCaption.textContent = "Chart library unavailable.";
        console.error("Chart library is unavailable; environmental charts could not be rendered.");
        return;
    }

    const history = Array.isArray(data.hourly_history)
        ? data.hourly_history.filter((item) =>
            item && typeof item.time === "string" &&
            isFiniteMeasurement(item.aqi) && isFiniteMeasurement(item.temperature))
        : [];
    const hasHistory = dataStatus === "live" && history.length > 1;
    const labels = hasHistory
        ? history.map((item) => item.time.includes("T") ? item.time.split("T")[1].slice(0, 5) : item.time)
        : ["Current"];
    const aqiValues = hasHistory ? history.map((item) => Number(item.aqi)) : [
        isFiniteMeasurement(data.aqi) ? Number(data.aqi) : null
    ];
    const temperatureValues = hasHistory ? history.map((item) => Number(item.temperature)) : [
        isFiniteMeasurement(data.temperature) ? Number(data.temperature) : null
    ];
    const sourceNote = dataStatus === "unavailable"
        ? "Live environmental data unavailable"
        : hasHistory
        ? "Open-Meteo hourly estimates · past 24 hours"
        : dataStatus === "live"
            ? "Current reading only · hourly history unavailable"
            : "Environmental data unavailable";
    if (aqiCaption) aqiCaption.textContent = `${sourceNote} · US AQI`;
    if (temperatureCaption) temperatureCaption.textContent = `${sourceNote} · °C`;

    const styles = getComputedStyle(document.documentElement);
    const ink = styles.getPropertyValue("--water").trim();
    const grid = styles.getPropertyValue("--line").trim();
    const muted = styles.getPropertyValue("--muted").trim();
    const createOptions = (unit, suggestedMax) => ({
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
            legend: { display: false },
            tooltip: {
                callbacks: {
                    label: (context) => `${context.dataset.label}: ${context.parsed.y}${unit}`
                }
            }
        },
        scales: {
            x: {
                grid: { display: false },
                ticks: { color: muted, maxTicksLimit: 8 }
            },
            y: {
                beginAtZero: unit === " AQI",
                suggestedMax,
                grid: { color: grid },
                ticks: {
                    color: muted,
                    callback: (value) => `${value}${unit}`
                }
            }
        }
    });
    const createDataset = (label, values) => ({
        label,
        data: values,
        borderColor: ink,
        backgroundColor: `${ink}22`,
        borderWidth: 2,
        pointRadius: hasHistory ? 2 : 5,
        pointHoverRadius: 5,
        tension: 0.3,
        fill: hasHistory,
        spanGaps: false
    });

    const aqiChartData = {
        labels,
        datasets: [createDataset("AQI", aqiValues)]
    };
    const temperatureChartData = {
        labels,
        datasets: [createDataset("Temperature", temperatureValues)]
    };

    if (aqiTrendChart) {
        aqiTrendChart.data = aqiChartData;
        aqiTrendChart.options = createOptions(" AQI", 100);
        aqiTrendChart.update();
    } else {
        aqiTrendChart = new Chart(aqiCanvas, {
        type: "line",
            data: aqiChartData,
            options: createOptions(" AQI", 100)
        });
    }

    if (temperatureTrendChart) {
        temperatureTrendChart.data = temperatureChartData;
        temperatureTrendChart.options = createOptions("°C", 30);
        temperatureTrendChart.update();
    } else {
        temperatureTrendChart = new Chart(temperatureCanvas, {
            type: "line",
            data: temperatureChartData,
            options: createOptions("°C", 30)
        });
    }
}

document.addEventListener("DOMContentLoaded", () => {
    if (window.environmentData) {
        renderEnvironmentalCharts(
            window.environmentData,
            window.environmentData.source === "open-meteo" ? "live" : "sample"
        );
    } else {
        renderEnvironmentalCharts({}, "unavailable");
    }
});

async function predictAQI(data, requestId, dataStatus) {
    const predictedAqiElement = document.getElementById("predictedAqiValue");
    const predictionStatus = document.getElementById("predictionStatus");
    const updateStatus = (message) => {
        if (predictionStatus) predictionStatus.textContent = message;
    };
    const pollutantMeasurements = {
        "PM2.5": data.pm25,
        "PM10": data.pm10,
        "NO": data.no,
        "NO2": data.nitrogen_dioxide ?? data.no2,
        "NOx": data.nox,
        "NH3": data.nh3,
        "CO": data.carbon_monoxide_mg_m3 ?? data.co,
        "SO2": data.sulphur_dioxide ?? data.so2,
        "O3": data.ozone ?? data.o3,
        "Benzene": data.benzene,
        "Toluene": data.toluene,
        "Xylene": data.xylene
    };
    const missingFeatures = Object.entries(pollutantMeasurements)
        .filter(([, value]) => !isFiniteMeasurement(value))
        .map(([feature]) => feature);
    const modelInput = Object.fromEntries(
        Object.entries(pollutantMeasurements).map(([feature, value]) => [
            feature,
            isFiniteMeasurement(value) ? Number(value) : 0
        ])
    );

    if (predictedAqiElement) predictedAqiElement.textContent = "--";
    updateStatus("Calculating…");

    try {
        const response = await fetch(
            `${API_BASE}/api/predict`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(modelInput)
            }
        );

        if (!response.ok) {
            throw new Error(`AQI prediction API returned ${response.status}`);
        }

        const result = await response.json();
        if (!result.success || !isFiniteMeasurement(result.predicted_aqi)) {
            throw new Error(result.error || "AQI prediction API returned an invalid prediction");
        }
        const treeSpread = result.model_tree_spread;

        if (requestId !== environmentRequestId) return;
        if (predictedAqiElement) {
            predictedAqiElement.textContent = Number(result.predicted_aqi).toFixed(2);
        }
        const sourceLabel = dataStatus === "fallback"
            ? "Sample fallback model estimate"
            : dataStatus === "sample"
                ? "Sample model estimate"
                : "Model estimate";
        const coverageLabel = `${Object.keys(pollutantMeasurements).length - missingFeatures.length}/12 pollutant readings available`;
        const spreadLabel = treeSpread &&
            isFiniteMeasurement(treeSpread.p10) &&
            isFiniteMeasurement(treeSpread.p90)
            ? `Tree spread ${Number(treeSpread.p10).toFixed(0)}–${Number(treeSpread.p90).toFixed(0)}; not a confidence interval`
            : "";
        const missingLabel = missingFeatures.length
            ? `${missingFeatures.length} unavailable reading(s) treated as 0`
            : "all model inputs available";
        updateStatus([sourceLabel, coverageLabel, missingLabel, spreadLabel].filter(Boolean).join(" · "));
    } catch (error) {
        if (requestId !== environmentRequestId) return;
        console.error("ML API connection failed:", error);
        updateStatus("Prediction unavailable");
    }
}
