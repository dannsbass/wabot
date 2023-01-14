const kutub = [
	'Shahih_Bukhari',
	'Shahih_Muslim',
	'Sunan_Abu_Daud',
	'Sunan_Tirmidzi',
	'Sunan_Nasai',
	'Sunan_Ibnu_Majah',
	'Musnad_Darimi',
	'Muwatho_Malik',
	'Musnad_Ahmad',
	'Sunan_Daraquthni',
	'Musnad_Syafii',
	'Mustadrak_Hakim',
	'Shahih_Ibnu_Khuzaimah',
	'Shahih_Ibnu_Hibban',
	'Bulughul_Maram',
	'Riyadhus_Shalihin'
]
const dkw = 'https://dkw.my.id'
const sedot = (url, opts) => import("node-fetch").then(({ default: fetch }) => fetch(url, opts));
import { Boom } from '@hapi/boom'
import MAIN_LOGGER from './src/Utils/logger'
import makeWASocket, { AnyMessageContent, delay, DisconnectReason, fetchLatestBaileysVersion, isJidBroadcast, makeCacheableSignalKeyStore, makeInMemoryStore, MessageRetryMap, MiscMessageGenerationOptions, proto, useMultiFileAuthState } from './src'

const logger = MAIN_LOGGER.child({ })
logger.level = 'trace'

const useStore = !process.argv.includes('--no-store')
const doReplies = !process.argv.includes('--no-reply')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterMap: MessageRetryMap = { }

// the store maintains the data of the WA connection in memory
// can be written out to a file & read from it
const store = useStore ? makeInMemoryStore({ logger }) : undefined
store?.readFromFile('./baileys_store_multi.json')
// save every 10s
setInterval(() => {
	store?.writeToFile('./baileys_store_multi.json')
}, 10_000)

// start a connection
const startSock = async() => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	// console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: true,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterMap,
		generateHighQualityLinkPreview: true,
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		shouldIgnoreJid: jid => isJidBroadcast(jid),
		// implement to handle retries
		getMessage: async key => {
			if(store) {
				const msg = await store.loadMessage(key.remoteJid!, key.id!)
				return msg?.message || undefined
			}

			// only if store is present
			return {
				conversation: 'hello'
			}
		}
	})

	store?.bind(sock.ev)

	const sendMessageWTyping = async(msg: AnyMessageContent, jid: string, options: MiscMessageGenerationOptions) => {
		await sock.presenceSubscribe(jid)
		await delay(500)

		await sock.sendPresenceUpdate('composing', jid)
		await delay(2000)

		await sock.sendPresenceUpdate('paused', jid)

		await sock.sendMessage(jid, msg, options)
	}

	const kirimPesan = async(msg, text) => {
		await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg })
	}

	function getKeyByValue(object, count) {
		if(object === 'Kosong') {
			return false
		}

		var obj = Object.keys(object).filter(key => object[key] === count)
		if(obj.length === 0) {
			return getKeyByValue(object, count - 1)
		}

		return { obj, count }
	  }

	  function getCount(str) {
		return str.trim().split(/\s+/).length
	  }

	async function kirimHadis({ msg, cocok }: { msg: proto.IWebMessageInfo; cocok: string[]}): Promise<void> {
		var namaKitab = cocok[1]
		var nomorHadis = cocok[2]
		const requestOptions = {
			method: 'GET',
		}
		sedot(dkw + '/?kitab=' + namaKitab + '&id=' + nomorHadis, requestOptions)
			.then(json => json.json())
			.then((data: { hasil: { nass_hadis: any; terjemah_hadis: any } }) => {
				if(data.hasil.nass_hadis && data.hasil.terjemah_hadis) {
					var nassHadis = data.hasil.nass_hadis
					var terjemahHadis = data.hasil.terjemah_hadis
					var pesanBalasan = nassHadis + '\n' + terjemahHadis
					return sock.sendMessage(msg!.key!.remoteJid!, { text: cocok[0] + '\n\n' + pesanBalasan }, { quoted: msg })
				} else {
					return sock.sendMessage(msg!.key!.remoteJid!, { text: 'Tidak valid' }, { quoted: msg })
				}
			})
	}


	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async(events) => {
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if(events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect } = update
				if(connection === 'close') {
					// reconnect if not logged out
					if((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
						startSock()
					} else {
						// console.log('Connection closed. You are logged out.')
					}
				}

				console.log('connection update', update)
			}

			// credentials updated -- save them
			if(events['creds.update']) {
				await saveCreds()
			}

			if(events.call) {
				// console.log('recv call event', events.call)
			}

			// history received
			if(events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest } = events['messaging-history.set']
				// console.log(`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest})`)
			}

			// received a new message
			if(events['messages.upsert']) {
				const upsert = events['messages.upsert']
				// console.log('recv messages ', JSON.stringify(upsert, undefined, 2))

				if(upsert.type === 'notify') {
					for(const msg of upsert.messages) {
						if(!msg.key.fromMe && doReplies) {
							// console.log('replying to', msg.key.remoteJid)
							// await sendMessageWTyping({ text: 'Ok!' }, msg.key.remoteJid!, { quoted: msg })
							const pesan = msg!.message!.conversation!
							//Shahih_Bukhari:1234
							const pattern = /^(\w+_\w+)\:(\d+)$/
							if(msg!.message!.listResponseMessage) {
								const cocok = pattern.exec(msg!.message!.listResponseMessage!.singleSelectReply!.selectedRowId!)
								if(cocok) {
									await kirimHadis({ msg, cocok })
									await sock!.readMessages([msg.key])
								}
							} else {
								const cocok = pattern.exec(pesan)
								if(cocok) {
									await kirimHadis({ msg, cocok })
									await sock!.readMessages([msg.key])
								} else {
									const str = pesan
									const query = encodeURIComponent(str)
									var list = []
									sedot(`${dkw}/?q=${query}`, { method: 'GET' }).then(response => response.json()).then((data: { hasil: any }) => {
										var hasil = getKeyByValue(data.hasil, getCount(str))
										if(!hasil) {
											sock!.sendMessage(msg!.key!.remoteJid!, { text: 'Maaf tidak ditemukan hasil' }, { quoted: msg })
											sock!.readMessages([msg.key])
										} else {
											var jml = 0
											hasil.obj.forEach((nilai: string, index: string | number): void => {
												jml++
												var arr = nilai.split(':')
												var kitab = kutub[arr[0]]
												var id = arr[1]
												list[index] = {
													title: jml,
													rows: [{
														title: kitab + ':' + id,
														rowId: kitab + ':' + id
													}]
												}
											})
											const perc = (hasil.count / getCount(str)) * 100
											const menuHasil = {
												title: 'Hasil Pencarian',
												text: `Ditemukan ${jml} hasil\nAkurasi: ${perc} %`,
												buttonText: 'Tampilkan hasil',
												viewOnce: true, // Whatsapp Business
												sections: list
											}
											sock!.sendMessage(msg.key.remoteJid!, menuHasil, { quoted: msg })
											sock!.readMessages([msg.key])
										}
									})
								}
							}
						}
					}
				}
			}

			// messages updated like status delivered, message deleted etc.
			if(events['messages.update']) {
				// console.log(events['messages.update'])
			}

			if(events['message-receipt.update']) {
				// console.log(events['message-receipt.update'])
			}

			if(events['messages.reaction']) {
				// console.log(events['messages.reaction'])
			}

			if(events['presence.update']) {
				// console.log(events['presence.update'])
			}

			if(events['chats.update']) {
				// console.log(events['chats.update'])
			}

			if(events['contacts.update']) {
				for(const contact of events['contacts.update']) {
					if(typeof contact.imgUrl !== 'undefined') {
						const newUrl = contact.imgUrl === null
							? null
							: await sock!.profilePictureUrl(contact.id!).catch(() => null)
						// console.log(
						// 	`contact ${contact.id} has a new profile pic: ${newUrl}`,
						// )
					}
				}
			}

			if(events['chats.delete']) {
				// console.log('chats deleted ', events['chats.delete'])
			}
		}
	)

	return sock
}

startSock()

function elseif(arg0: boolean | proto.Message.IListResponseMessage | null | undefined) {
	throw new Error('Function not implemented.')
}
