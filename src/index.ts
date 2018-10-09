import express = require('express')
import rp = require('request-promise')
const app = express()

interface Config {
  server_address: string
  server_port: string
  server_id: string
  api_key?: string
  zone_id?: string
  default_ttl: number
  protectedNames: string[]
  macNameOverrides: {[mac: string]: string}
}

const defaultConfig: Config = {
  server_address: '127.0.0.1',
  server_port: '8081',
  server_id: 'localhost',
  default_ttl: 3600,
  protectedNames: [],
  macNameOverrides: {},
}

//config
const config = {
  ...defaultConfig,
  ...(require(process.env.PDNS_DDNS_CONFIG || '/etc/pdns-ddns.json') as Config),
}

if (config.api_key === undefined) throw new Error('API Key undefined')
if (config.zone_id === undefined) throw new Error('Zone ID undefined')

// clean-up config
config.protectedNames = config.protectedNames.map(x => x.toLowerCase())
config.macNameOverrides = Object.entries(config.macNameOverrides).reduce((acc, [k, v]) => {
  acc[k.toLowerCase()] = cleanHostName(v)
  return acc
}, {} as typeof config.macNameOverrides)

app.get('/', function(_req, res) {
  res.send('Hello world!')
})

type RRSet = {
  name: string
  type: 'A'
} & (
  | { changetype: 'DELETE' }
  | {
      changetype: 'REPLACE'
      ttl: number
      records: Record[]
    })

interface RR {
  name: string
  type: 'A'
  ttl: number
  records: Record[]
}

interface Record {
  content: string
  disabled: false
  'set-ptr'?: true
}

interface ZonePatch {
  rrsets: RRSet[]
}

interface Zone {
  id: string
  kind: string
  name: string
  rrsets: RR[]
}

async function getZone(): Promise<Zone> {
  return rp({
    method: 'GET',
    json: true,
    url: `http://${config.server_address}:${
      config.server_port
    }/api/v1/servers/${config.server_id}/zones/${config.zone_id}`,
    headers: {
      'X-API-Key': config.api_key,
    },
  })
}

async function patchZone(rrsets: RRSet[]) {
  try {
    return await rp({
      method: 'PATCH',
      json: true,
      body: { rrsets } as ZonePatch,
      url: `http://${config.server_address}:${
        config.server_port
      }/api/v1/servers/${config.server_id}/zones/${config.zone_id}`,
      headers: {
        'X-API-Key': config.api_key,
      },
    })
  } catch (e) {
    console.log(e)
  }
}

interface NewLeaseData {
  leaseBound: '0' | '1'
  leaseServerName: string
  leaseActMAC: string
  leaseActIP: string
  hostname: string
  dynamic: 'true' | 'false'
}

function cleanHostName(hostname: string) {
  return hostname.split('.')[0].replace(/[^A-Za-z0-9_-]/, '').toLowerCase()
}

async function handleNewLease(data: NewLeaseData) {
  let newhostname = cleanHostName(data.hostname)
  if (data.dynamic === 'false') {
    console.log(`Got new lease for ${newhostname}, but it's static. Bailing`)
    return
  }
  if (config.macNameOverrides[data.leaseActMAC.toLowerCase()]) {
    newhostname = config.macNameOverrides[data.leaseActMAC.toLowerCase()]
    console.log(`Found a mac-name override for ${data.leaseActMAC}: ${newhostname}`)
  }
  if (newhostname === '') {
    if (data.leaseActMAC === '') {
      console.log('Both hostname and MAC are empty. Bailing')
      return
    }
    newhostname = cleanHostName(`client-${data.leaseActMAC.replace(/:/g, '-')}`)
    console.log(`Got zero-length hostname after filtering from ${data.hostname}. Generated new hostname based on MAC: ${newhostname}`)
  }
  if (config.protectedNames.includes(newhostname)) {
    console.log(`Got new lease for ${newhostname}, but it's protected. Bailing`)
    return
  }
  const fullhostname = `${newhostname}.${config.zone_id}`
  const zone = await getZone()
  const rrset = zone.rrsets.find(
    (x) => x.name === fullhostname && x.type === 'A',
  )
  if (data.leaseBound === '1') {
    console.log(`New lease for ${newhostname} with ip ${data.leaseActIP}`)
    const record =
      rrset && rrset.records.find((x) => x.content === data.leaseActIP)
    if (record) {
      console.log(
        `Found record for ${newhostname} with ip ${
          data.leaseActIP
        }, doing nothing`,
      )
      return
    }
    await patchZone([
      {
        name: fullhostname,
        changetype: 'REPLACE',
        ttl: config.default_ttl,
        type: 'A',
        records: [
          {
            content: data.leaseActIP,
            'set-ptr': true,
            disabled: false,
          },
        ],
      },
    ])
  }
}

app.use(express.urlencoded({ extended: false }))

app.post('/dhcp/new-lease', function(req, res) {
  handleNewLease(req.body).catch(function(e) {
    console.log(e)
  })
  res.sendStatus(200)
})

app.listen(3000)
