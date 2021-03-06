/*********************************************************************
 *     JAVASCRIPT DISCORD RECORDER AND SOUNDBOARD BOT - JS DRaSB
 *
 *  This is a JavaScript Node.js Discord bot based on discord.js library
 *  that is meant to perform automatic recording of a discord channel
 *  and play music/sounds as a soundboard or a playlist bot.
 *
 *  DRaSB is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License version 3.
 *
 *  JS_DRaSB Copyright 2018-2019 - Anton Grushin
 *
 *
 *        bot.js
 *    Main bot executable.
 *********************************************************************/
var Discord = require('discord.js');
const ytdl = require('ytdl-core');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const https = require('https');
const client = new Discord.Client();
//var heapdump = require('heapdump');
const { PassThrough } = require('stream');  //For piping file stream to ffmpeg

//Load bot parts
//const config = require('./config.js');
const utils = require('./utils.js');
var db = require('./database.js');
//Config
var opt = require('./opt.js');
var config = opt.opt;

//Classes from DiscordJs for refreshing
const AudioPlayer = require('discord.js/src/client/voice/player/AudioPlayer');

//technical variables
var BotReady = false; //This turns true when we are connected to Discord server
var RecordsDBReady = false;
var LastChannelChangeTimeMs = Date.now(); //Time in ms when we did last channel change so we can wait until new join to stop command flooding
var ChannelWaitingToJoin = null;
var PlayingQueue = [];
var PausingThePlayback = false;
var CurrentPlayingSound = {};
var CurrentVolume = 0.0;
var queueDBWrite = [];
var lastQueueElements = [];
var ffmpegPlaybackCommands = [];

var soundIsPlaying = false;
var PreparingToPlaySound = false;
var LastPlaybackTime = Date.now();

// =============== HELPER FUNCTIONS ===============

//Return user tag or nam depending on PlaybackStatusMessagesTagPeople option
function getUserTagName(user) {
	if (config.PlaybackStatusMessagesTagPeople)
		return "<@" + user.id + ">";
	else {
		let output = getUserName(user);
		return (output != false ? output : "");
	}
}

//Get the name of the User or return false if he is not part of the guild
function getUserName(User) {
	let member = client.guilds.get(config.guildId).members.get(User.id);
	if (member) {
		if (member.nickname)
			return member.nickname;
		else
			return User.username;
	}
	else  
		return false;
}

//Get total duration of the queue
function getQueueDuration() {
	let totalDuration = 0;
	for (i in PlayingQueue) {
		if (PlayingQueue[i]['duration']) {
			totalDuration += PlayingQueue[i]['duration'];
			if (PlayingQueue[i]['played'])
				totalDuration -= PlayingQueue[i]['played'] / 1000;
		}
	}
	return totalDuration;
}

//Calculate volume value using global config and personal volume level, inputs percentage 0.0-100.0, outputs 0.0-1.0
function calcVolumeToSet(personalVol) {
	//config.VolumeBotGlobal - this is considered 100% volume
	return (personalVol * (config.VolumeBotGlobal / 100)) / 100;
}

//Return amount of members in a voice channel (excluding bots)
function countChannelMembers(channel) {
	if (channel)
		return channel.members.filter(member => !member.user.bot).size;
	else
		return 0;
}

//Send Informational message on a channel
function sendInfoMessage(message, channel, user = null) {
	if (BotReady && message.length > 0) {
		utils.report("InfoMessage: " + (user != null ? user.username + ", " : "") + message, 'c');
		let channelToSendTo = channel;
		if (config.RestrictCommandsToSingleChannel && channel.type != "dm")
			channelToSendTo = client.channels.get(config.ReportChannelId);
		if (channelToSendTo) {
			channelToSendTo.send((user != null ? "<@" + user.id + ">, " : "") + message)
				.then(sentMsg => {
					if (config.InfoMessagesDelete && channelToSendTo.type != "dm") {
						setTimeout(() => {
							sentMsg.delete()
								.catch(error => utils.report("Couldn't delete informational message on channel '" + channelToSendTo.name + "'. Error: " + error, 'r'));
						}, config.InfoMessagedDeleteTimeout * 1000);
					}
				})
				.catch(error => utils.report("Couldn't send a message to channel '" + channelToSendTo.name + "'. Error: " + error, 'r'));
		}
		else
			utils.report("'ReportChannelId' that you specified in the config file is not avaliable to the bot! Can't send messages there.", 'r');
	}
}

//Send Playback Status message
function playbackMessage(message) {
	utils.report("Playback: " + message, 'g');
	channelToSendTo = client.channels.get(config.ReportChannelId);
	if (config.PlaybackStatusMessagesSend) {
		if (channelToSendTo) {
			channelToSendTo.send(message)
				.catch(error => utils.report("Couldn't send a message to channel '" + channelToSendTo.name + "'. Error: " + error, 'r'));
		}
		else
			utils.report("'ReportChannelId' that you specified in the config file is not avaliable to the bot! Can't send messages there.", 'r');
	}
}

//Send message or several if it exceeds Character limit
function breakMessage(message, usedCount = 0, beginMessage="", endMessage="", backwards=false) {
	let result = [];
	if (message.length > config.MessageCharacterLimit - usedCount) {
		let cutted = message.split('\n');
		let thisChunk = "";
		//If its backwards we cut message from the end
		if (backwards) {
			for (i in cutted) {
				if (thisChunk.length + cutted[cutted.length - i - 1].length <= config.MessageCharacterLimit - (beginMessage.length + endMessage.length + 2 + usedCount))
					//thisChunk += cutted[i] + "\n";
					thisChunk = cutted[cutted.length - i - 1] + "\n" + thisChunk;
				else {
					result.push(beginMessage + thisChunk + endMessage);
					thisChunk = cutted[i];
				}
			}
			return result;
		}
		else {
			for (i in cutted) {
				if (thisChunk.length + cutted[i].length <= config.MessageCharacterLimit - (beginMessage.length + endMessage.length + 2 + usedCount))
					thisChunk += cutted[i] + "\n";
				else {
					result.push(beginMessage + thisChunk + endMessage);
					thisChunk = cutted[i] + "\n";
				}
			}
			return result;
		}
	}
	else
		return [beginMessage + message + endMessage];
}

//Return voiceChannel from a Member or return current voice channel that bot is on right now
function getVoiceChannel(Member) {
	let currConnection = getCurrentVoiceConnection();
	if (Member.voiceChannel)
		return Member.voiceChannel;
	else if (currConnection)
		return currConnection.channel;
	else
		return null;
}

function prepareForPlaybackOnChannel(guildMember, permissionLevel = {}, joinStrict = false) {
	return new Promise((resolve, reject) => {
		if (guildMember.voiceChannel || getCurrentVoiceConnection()) {
			if (getVoiceChannel(guildMember)) {
				checkChannelJoin(getVoiceChannel(guildMember))
					.then((connection) => { return resolve(connection); })
					.catch(error => {
						utils.report("Couldn't join channel. Error: " + error, 'r');
						return resolve(null);
					});
			}
			else {
				sendInfoMessage("I dont have permission to join that channel!", client.channels.get(config.ReportChannelId), guildMember.user);
				return resolve(null);
			}
		}
		else {
			sendInfoMessage("Join a voice channel first!", client.channels.get(config.ReportChannelId), guildMember.user);
			return resolve(null);
		}
	});
}

//Return true if guildmember has specified bit of permission
function checkPermission(guildmember, bit=31, channel=null, postMessage=true) {
	let permission = 0;
	//We count bits from right to left
	//SummonBot:					0
	//DismissBot:					1
	//PlayFiles:					2
	//PlayYoutubeLinks:				3
	//UploadLocalAudioFiles:		4
	//DeleteLocalAudioFiles:		5
	//RecieveListOfLocalAudios		6
	//PauseResumeSkipPlayback		7
	//RejoinChannel					8
	//StopPlaybackClearQueue		9
	//RenameLocalAudioFiles			10
	//SetVolumeAbove100				11
	//HideOwnRecords				12
	//PlayRecordsIfWasOnTheChannel	13
	//PlayAnyonesRecords:			14
	//PlayRandomQuote				15
	//RepeatLastPlayback			16
	//DeleteOwnLocalAudioFiles		17
	//RenameOwnLocalAudioFiles		18

	//If he is admin
	if (config.permissions.AdminsList.indexOf(guildmember.user.id) > -1)
		return true;
	//If member is in the Blacklist
	else if (config.permissions.BlackList.indexOf(guildmember.user.id) > -1)
		return false;
	//If Permission level is (Blacklist) or (Whitelist and Member has proper role)
	else if (config.permissions.PermissionsLevel == 0 || (config.permissions.PermissionsLevel == 1 && guildmember.roles.array().some(Role => { return config.permissions.UserRolesList.includes(Role.id) || config.permissions.UserRolesList.includes(Role.name); }))) {
		//Sum up permission bits
		permission += config.permissions.User.SummonBot << 0;
		permission += config.permissions.User.DismissBot << 1;
		permission += config.permissions.User.PlayFiles << 2;
		permission += config.permissions.User.PlayYoutubeLinks << 3;
		permission += config.permissions.User.UploadLocalAudioFiles << 4;
		permission += config.permissions.User.DeleteLocalAudioFiles << 5;
		permission += config.permissions.User.RecieveListOfLocalAudios << 6;
		permission += config.permissions.User.PauseResumeSkipPlayback << 7;
		permission += config.permissions.User.RejoinChannel << 8;
		permission += config.permissions.User.StopPlaybackClearQueue << 9;
		permission += config.permissions.User.RenameLocalAudioFiles << 10;
		permission += config.permissions.User.SetVolumeAbove100 << 11;
		permission += config.permissions.User.HideOwnRecords << 12;
		permission += config.permissions.User.PlayRecordsIfWasOnTheChannel << 13;
		permission += config.permissions.User.PlayAnyonesRecords << 14;
		permission += config.permissions.User.PlayRandomQuote << 15;
		permission += config.permissions.User.RepeatLastPlayback << 16;
		permission += config.permissions.User.DeleteOwnLocalAudioFiles << 17;
		permission += config.permissions.User.RenameOwnLocalAudioFiles << 18;
	}
	let result = (permission & (1 << bit)) > 0;
	if (!result && postMessage)
		sendInfoMessage("You don't have permission for that! :pensive:", channel ? channel : client.channels.get(config.ReportChannelId), guildmember.user);
	return result;
}

//Recreate Audio Player to avoid buffer overloading and as a result delayed playback
function recreatePlayer(connection=null) {
	let foundConnection = null;
	if (connection)
		foundConnection = connection;
	else if (getCurrentVoiceConnection())
		foundConnection = getCurrentVoiceConnection();

	if (foundConnection) {
		delete foundConnection.player;
		foundConnection.player = new AudioPlayer(foundConnection);
	}
}

//Return current client voice connection or null if there is none
function getCurrentVoiceConnection() {
	if (client.voiceConnections ? client.voiceConnections.array().length > 0 : false)
		return client.voiceConnections.array()[0];
	else
		return null;
}

//Write stats to database
function writeQueueToDB() {
	if (queueDBWrite.length > 0) {
		let dbTransaction = db.getDB().transaction(() => {
			while (queueDBWrite.length > 0) {
				let element = queueDBWrite.shift();

				if (element.function == 'userPlayedSoundsInc') {
					db.userPlayedSoundsInc(element.argument);
				}
				else if (element.function == 'soundPlayedInc') {
					db.soundPlayedInc(element.argument);
				}
				else if (element.function == 'userPlayedRecsInc') {
					db.userPlayedRecsInc(element.argument);
				}
				else if (element.function == 'userPlayedYoutubeInc') {
					db.userPlayedYoutubeInc(element.argument);
				}
			}
		});
		dbTransaction();
	}
}

function deletePlaybackCommands() {
	for (i in ffmpegPlaybackCommands) {
		if (process.platform === "linux")
			ffmpegPlaybackCommands[i].kill('SIGSTOP');
		//If command is not stopped within 5 seconds, force to kill the process
		setTimeout(() => {
			if (ffmpegPlaybackCommands[i]) {
				if (process.platform === "linux")
					try {
						ffmpegPlaybackCommands[i].kill();
						delete ffmpegPlaybackCommands[i];
					} catch (err) { }
			}
		}, 100);
	}
}

// =============== SOUND FUNCTIONS ===============

//Destroy all voice recievers
function recieversDestroy() {
	let connection = getCurrentVoiceConnection();
	if (connection) {
		if (config.logging.ConsoleReport.ChannelJoiningLeaving) utils.report("Leaving channel '" + connection.channel.name + "'!", 'g', config.logging.LogFileReport.ChannelJoiningLeaving);
		db.AddUserActivity(0, connection.channel.id, 1);
		connection.channel.leave();
	}
}

//Start recording on currently connected channel
function startRecording(connection) {
	return new Promise((resolve, reject) => {
		//For some reason in order to recieve any incoming voice data from other members we need to send something first, therefore we are sending a very short sound and start the recording right after
		const dispatcher = connection.playFile(path.resolve(__dirname, config.folders.Sounds, '00_empty.mp3'));

		dispatcher.on('end', () => {
			utils.report("Starting recording of '" + connection.channel.name + "' channel.", 'g')

			const receiver = connection.createReceiver();
			connection.on('speaking', (user, speaking) => {
				if (speaking) {

					const audioStream = receiver.createPCMStream(user);
					let chunkCount = 0;
					let totalStreamSize = 0;
					let fileTimeNow = utils.fileTimeNow();
					let tempfile = path.resolve(__dirname, config.folders.Temp, fileTimeNow + '_' + utils.sanitizeFilename(user.username));
					const writable = fs.createWriteStream(tempfile + '.pcm');

					audioStream.on('data', (chunk) => {
						chunkCount++;
						totalStreamSize += chunk.length;
					});
					//Write the data to the temp file
					audioStream.pipe(writable);

					audioStream.on('end', () => {
						//Each chunk is 20 ms
						let durationMs = chunkCount * 20;
						if (config.logging.ConsoleReport.RecordDebugMessages) utils.report("Got " + chunkCount + " chunks with total size of " + totalStreamSize + " bytes from user '" + getUserName(user) + "'.", 'c', config.logging.LogFileReport.RecordDebugMessages); //debug message

						if (durationMs > config.RecordingsDurationSkipThresholdMs) {
							//let outputFile = path.resolve(__dirname, config.folders.VoiceRecording, fileTimeNow + '_' + utils.cutFillString(user.id, 20) + '_' + utils.cutFillString(durationMs, 10, '0') + '_' + utils.sanitizeFilename(getUserName(user)) + '.' + config.RecordingAudioContainer)
							let targetFile = path.resolve(__dirname, config.folders.VoiceRecording, fileTimeNow.file + '_' + user.id + '_' + durationMs + '_' + utils.sanitizeFilename(getUserName(user)) + '.' + config.RecordingAudioContainer);
							let FFcommand = ffmpeg(tempfile + '.pcm', { niceness: 20 })
								.noVideo()
								.inputOptions([
									'-f', 's16le',
									'-ac', '2',
									'-ar', '48000'
								])
								.audioCodec(config.RecordingAudioCodec)
								.audioBitrate(config.RecordingAudioBitrate)
								.on('error', function (err) {
									utils.report("ffmpeg reported error: " + err, 'r')
								})
								.on('end', function (stdout, stderr) {
									if (config.logging.ConsoleReport.RecFilesSavedAndProcessed) utils.report("Saved recording of '" + user.username + "' with duration of " + durationMs + " ms (" + chunkCount + " chunks).", 'c', config.logging.LogFileReport.RecFilesSavedAndProcessed);
									fs.unlink(tempfile + '.pcm', err => {
										if (err) utils.report("Couldn't delete temp file '" + tempfile + "'. Error: " + err, 'r');
									});
									//Add to the database
									fs.stat(targetFile, (err, stats) => {
										if (!err)
											db.recordingAdd(targetFile, fileTimeNow.now.getTime(), durationMs, user.id, stats.size, false, connection.channel.id, countChannelMembers(connection.channel));
										else
											utils.report("Couldn't read file property of '" + targetFile + "'. Error: " + err, 'r');
									});
								})
								.on('codecData', format => {
									if (config.logging.ConsoleReport.RecordDebugMessages) utils.report("ffmpeg reports stream properties. Duration:" + format['duration'] + ", audio: " + format['audio_details'] + ".", 'c', config.logging.LogFileReport.RecordDebugMessages); //debug message
								})
								.on('start', function (commandLine) {
									//if (config.logging.ConsoleReport.FfmpegDebug) utils.report('Spawned Ffmpeg with command: ' + commandLine, 'w', config.logging.LogFileReport.FfmpegDebug); //debug message
								})
								.output(targetFile)
								.run();
						}
						else
							fs.unlink(tempfile + '.pcm', err => {
								if (err) utils.report("Couldn't delete temp file '" + tempfile + "'. Error: " + err, 'r');
							});
					});
					
				}
			})
			connection.on('error', (err) => utils.report("There was an error in voice connection: " + err, 'r'));

			return resolve(dispatcher);
		});
		dispatcher.on('error', error => utils.report("Couldn't play sound file '" + path.resolve(__dirname, config.folders.Sounds, '00_empty.mp3') + "' on'" + connection.channel.name + "' channel. Error: " + error, 'r'));
		
	});
}

//Join voice channel actions
function joinVoiceChannel(channel) {
	return new Promise((resolve, reject) => {
		//First, delete all previously created recievers if we have any
		recieversDestroy();

		//Join the channel
		channel.join()
			.then(connection => {
				if (config.logging.ConsoleReport.ChannelJoiningLeaving) utils.report("Joined channel '" + channel.name + "'!", 'g', config.logging.LogFileReport.ChannelJoiningLeaving);
				db.AddUserActivity(0, channel.id, 0);
				//If we have Voice Recording enabled, launch it
				if (config.EnableRecording) {
					startRecording(connection)
						.then(() => { return resolve(connection); });
				}

				//Actions performed, empty the queue
				LastChannelChangeTimeMs = Date.now();
				ChannelWaitingToJoin = null;

				
			})
			.catch(error => {
				utils.report("Couldn't join channel '" + channel.name + "'. Error: " + error, 'r');
				return reject(error);
			});
		//Actions performed, empty the queue
		LastChannelChangeTimeMs = Date.now();
		ChannelWaitingToJoin = null;
	});
}

//Join voice channel queue function
//   We have channel that we want to join stored in 'ChannelWaitingToJoin', this is our joining 
//   queue (technically its not queue, only last channel since we dont need others but who cares).
//   We check time since last joining. If it passed, we join strait away if not, we delay the function.
//   If we dont do this and bot joins channels without waiting too quickly, we will get situation
//   when we technically didnt leave previous channel and still have recievers on it resulting in bot crash
//   due to VoiceConnection.authenticateFailed Error: Connection not established within 15 seconds
function joinVoiceChannelQueue(channel) {
	return new Promise((resolve, reject) => {
		//if channel exists
		if (channel.name && channel.joinable) {

			//If there is a channel in the queue, just reset the variable, command is queued, so dont run it again
			if (ChannelWaitingToJoin) {
				if (config.logging.ConsoleReport.ChannelDebugJoinQueue) utils.report("Channel join queue: There is a channel in the queue '" + ChannelWaitingToJoin.name + "', setting new channel: '" + channel.name + "'!", 'c', config.logging.LogFileReport.ChannelDebugJoinQueue); //debug message
				ChannelWaitingToJoin = channel;
				//Return Promise in expected time of channel changing plus 100ms
				// todo: find a better solution for this, this is a very nasty way:
				// it will return resolve() even if joining operation failed
				setTimeout(() => {
					let connToReturn = getCurrentVoiceConnection()
					if (connToReturn)
						return resolve(connToReturn);
					throw new Error("Couldn't join channel in given time. Try again.")
				}, (config.ChannelJoiningQueueWaitTimeMs - (Date.now() - LastChannelChangeTimeMs) + 100));
			}
			else {
				let JoinHappendMsAgo = Date.now() - LastChannelChangeTimeMs;
				if (JoinHappendMsAgo >= config.ChannelJoiningQueueWaitTimeMs) {
					//We can run it without waiting
					if (config.logging.ConsoleReport.ChannelDebugJoinQueue) utils.report("Channel join queue: Joining '" + channel.name + "' channel without any delay!", 'c', config.logging.LogFileReport.ChannelDebugJoinQueue); //debug message
					joinVoiceChannel(channel)
						.then((connection) => { return resolve(connection); })
						.catch(error => { return reject(error); });
				}
				else {
					//Delay joining
					ChannelWaitingToJoin = channel;
					if (config.logging.ConsoleReport.ChannelDebugJoinQueue) utils.report("Channel join queue: Delaying joining '" + ChannelWaitingToJoin.name + "' channel by " + Math.floor(config.ChannelJoiningQueueWaitTimeMs - JoinHappendMsAgo) + " ms!", 'c', config.logging.LogFileReport.ChannelDebugJoinQueue); //debug message
					setTimeout(() => {
						joinVoiceChannel(ChannelWaitingToJoin)
							.then((connection) => { return resolve(connection); })
							.catch(error => { return reject(error); });
					}, (config.ChannelJoiningQueueWaitTimeMs - JoinHappendMsAgo));
				}
			}
		}
		else
			return reject("No permission to join the channel.");
	});
}

//Check for arguments in the command
function checkForEmptyArguments(args = [], channel = null, author = null) {
	let noArguments = true;
	for (i in args) {
		if (args[i].length > 0) {
			noArguments = false;
			break;
		}
	}
	if (noArguments)
		sendInfoMessage("You did not specify any arguments in your command!", channel, author);

	return noArguments;
}

//Check if we are on the channel, if we are - do nothing, if not - join it
function checkChannelJoin(channel) {
	return new Promise((resolve, reject) => {
		let haveConnection = false;
		let connToReturn = getCurrentVoiceConnection();
		if (connToReturn) {
			haveConnection = true;
			return resolve(connToReturn);
		}
		//No connection found, create new one
		if (channel) {
			if (!haveConnection) {
				joinVoiceChannelQueue(channel)
					.then((connection) => { return resolve(connection); })
					.catch(error => { return reject(error); });
			}
		}
		else
			throw new Error("Join a voice channel first!")
	});
}

//Set current volume level to desired value
function setVolume(volume, time) {
	let currConnection = getCurrentVoiceConnection();
	if (currConnection) {
		let iterations = Math.floor(time / 20);
		let volDelta = (volume - CurrentVolume) / iterations;
		//Each packet sent is 20ms long, so no need to change it more often since it won't have any effect
		volumeIterate(currConnection.dispatcher, iterations, 20, volDelta, CurrentVolume);
		CurrentVolume = volume;
	}
}

//Smoothly change the volume by iterations with a wait period
function volumeIterate(dispatcher, itLeft, waitperiod, volumeChange, volumeNow) {
	if (itLeft > 0) {
		let newVolume = volumeNow + volumeChange;
		//console.log("VolumeIteration: # " + itLeft + ", waitPeriod: " + waitperiod+" ms,volumeChange: " + volumeChange + ", newVolumeSet: " + newVolume); //Debug
		dispatcher.setVolume(newVolume);
		CurrentVolume = newVolume;
		setTimeout(() => {
			volumeIterate(dispatcher, itLeft - 1, waitperiod, volumeChange, newVolume);
		}, waitperiod);
	}
}

//What to do when fdmpeg stream is ready to be executed
function executeFFMPEG(connection, PlaybackOptions, inputObject, inputList, mode = { how: 'concat' }) {
	let effects = {};
	if ('effects' in inputObject.flags)
		effects = inputObject.flags.effects;

	let command = utils.buildFfmpegCommand(inputList, effects, mode, config.ComplexFiltersAmountLimit);
	if (command) {
		command = command.audioChannels(2).audioFrequency(48000);

		//If we have start time
		let startTime = utils.get(inputObject, 'flags.start');
		if (startTime)
			command = command.seek(startTime);

		//If we have duration
		let duration = utils.get(inputObject, 'flags.duration');

		//if we have end time
		let endTime = utils.get(inputObject, 'flags.end');
		if (endTime) {
			let diff = endTime - (startTime ? startTime : 0);
			duration = diff > 0 ? diff : null;
		}

		if (duration)
			command = command.duration(duration);

		//command
		//	.on('error', function (err) {
		//		utils.report("ffmpeg reported " + err, 'r');
		//		if (ffstream) {
		//			ffstream.destroy();
		//			//global.gc();
		//		}

		//		if (process.platform === "linux")
		//			command.kill('SIGSTOP'); //This does not work on Windows
		//		//command.kill();
		//	})
		//.on('end', function (stdout, stderr) {
		//	//if (stream)
		//	//	stream.close();
		//	//if (ffstream)
		//	//	ffstream.end();
		//})
		//.on('progress', function (progress) {
		//	console.log('Processing: ' + Math.round(progress.percent) / 100 + '% done (' + progress.timemark + ') ' + progress.targetSize + ' Kb');
		//})


		//Redirect to an output
		let target = utils.get(inputObject, 'flags.target');
		if (target) {
			PreparingToPlaySound = false;
			//Remove command character from the beginning if we have it
			if (target.substring(0, config.CommandCharacter.length) == config.CommandCharacter)
				target = target.substring(config.CommandCharacter.length);

			//Check for unwanted characters in the string and remove them
			target = target.replace(/[/\\?%*:|"<> ]/g, '');

			//Add a number in the end if file exists already
			target = utils.incrementFilename(target + '.' + config.ConvertUploadedAudioContainer, config.folders.Sounds);

			if (target) {
				let tempFile = path.resolve(__dirname, config.folders.Temp, target);
				let targetFile = path.resolve(__dirname, config.folders.Sounds, target);
				command = command
					.audioCodec(config.ConvertUploadedAudioCodec)
					.audioBitrate(config.ConvertUploadedAudioBitrate)
					.output(tempFile)
					.on('end', function (stdout, stderr) {
						//Move file to Sounds dir
						utils.moveFile(tempFile, targetFile)
							.then(() => {
								utils.checkAudioFormat(targetFile)
									.then(resultNew => {
										fs.stat(targetFile, (err, stats) => {
											if (!err) {
												let transaction = db.getDB().transaction(() => {
													db.userUploadedSoundsInc(inputObject.user.id); //Increment value in DB for statistics
													db.soundUpdateAdd(path.parse(targetFile).name + path.parse(targetFile).ext, resultNew['metadata']['format']['duration'], fs.statSync(targetFile).size, resultNew['metadata']['format']['bitrate'], inputObject.user.id);
												});
												transaction();
												sendInfoMessage("File saved! Now you can play it using **" + config.CommandCharacter + path.parse(targetFile).name.toLowerCase() + "** command.", client.channels.get(config.ReportChannelId), inputObject.user.user);
												if (inputObject.type == 'file') {
													utils.report(getUserName(inputObject.user.user) + " resaved file '" + inputObject.filename + "' with duration of " + resultNew['metadata']['format']['duration'] + " seconds as a command '" + path.parse(targetFile).name.toLowerCase() + "'.", 'm');
												}
												else if (inputObject.type == 'recording' && inputObject.mode.how == 'phrase') {
													utils.report(getUserName(inputObject.user.user) + " saved quote said by '" + db.getUserGuildName(inputObject.searchresult.author) + "' at " + utils.getDateFormatted(inputObject.limits.start, "D MMM YYYY, HH:mm z") + " with duration of " + resultNew['metadata']['format']['duration'] + " seconds as a command '" + path.parse(targetFile).name.toLowerCase() + "'.", 'm');
												}
												else if (inputObject.type == 'youtube') {
													utils.report(getUserName(inputObject.user.user) + " saved YouTube '" + inputObject.title.substring(0, config.YoutubeTitleLengthLimit) + "' (" + inputObject.link + ") with result duration of " + resultNew['metadata']['format']['duration'] + " seconds as a command '" + path.parse(targetFile).name.toLowerCase() + "'.", 'm');
												}
											}
											else {
												utils.report("Couldn't read file property of '" + targetFile + "'. Error: " + err, 'r');
												sendInfoMessage("Something went wrong while processing the file :pensive: ", client.channels.get(config.ReportChannelId), inputObject.user.user);
											}
										});
										
									});
								//db.scanSoundsFolder();
							})
							.catch(err => {
								sendInfoMessage("There was an error while performing file move! Operation was not finished.", client.channels.get(config.ReportChannelId), inputObject.user.user);
								utils.report("Couldn't move file '" + tempFile + "' to '" + targetFile + "'. Check permissions or disk space.", 'r');
							});
					})
					.on('start', function (commandLine) {
						if (config.logging.ConsoleReport.FfmpegDebug) utils.report('Spawned Ffmpeg with command: ' + commandLine, 'w', config.logging.LogFileReport.FfmpegDebug); //debug message
						sendInfoMessage("Started processing... Please, wait (this may take a while).", client.channels.get(config.ReportChannelId), inputObject.user.user);
						//ffmpegPlaybackCommands.push(command);
					})
					.on('error', function (err) {
						utils.report("ffmpeg reported " + err, 'r');

						if (process.platform === "linux")
							command.kill('SIGSTOP'); //This does not work on Windows
						//command.kill();
					})
					.run();
			}
			else {
				sendInfoMessage("Can't execute it! (Bad filename?)", client.channels.get(config.ReportChannelId), inputObject.user.user);
			}
		}
		//Play on current channel
		else {

			function checkHang(timeout, iterationsToCheck = 100) {
				if (iterationsToCheck > 0) {
					console.log(utils.msCount("CheckHang"));
					setTimeout(() => {
						checkHang(timeout, iterationsToCheck - 1);
					}, timeout);
				}
				else
					utils.msCount("CheckHang", 'reset');
			}

			const ffstream = new PassThrough();
			command
				.on('start', function (commandLine) {
					//checkHang(20, 200);
					if (config.logging.ConsoleReport.FfmpegDebug) utils.report('Spawned Ffmpeg with command: ' + commandLine, 'w', config.logging.LogFileReport.FfmpegDebug); //debug message
					ffmpegPlaybackCommands.push(command);
				})
				.on('error', function (err) {
					utils.report("ffmpeg reported " + err, 'r');
					if (ffstream) {
						ffstream.destroy();
						//global.gc();
					}

					if (process.platform === "linux")
						command.kill('SIGSTOP'); //This does not work on Windows
					//command.kill();
				})
				.format('s16le').pipe(ffstream);

			connection.playConvertedStream(ffstream, PlaybackOptions);
			//Attach event listeners
			attachEventsOnPlayback(connection);

			//Report information
			if (inputObject.type == 'file') {
				playbackMessage(":musical_note: Playing file `" + CurrentPlayingSound.filename + "`" + utils.flagsToString(inputObject.flags) + ", duration " + utils.humanTime(CurrentPlayingSound.duration) + ". Requested by " + getUserTagName(CurrentPlayingSound.user) + "." + (inputObject.played ? " Resuming from " + Math.round(inputObject.played / 1000) + " second!" : ""));
			}
			else if (inputObject.type == 'recording') {
				if ((inputObject.chunkIndex == 1 || !inputObject.chunkIndex) && inputObject.mode.how == 'sequence')
					playbackMessage(":record_button: Playing recording of `" + utils.getDateFormatted(inputObject.limits.start, "D MMM YYYY, HH:mm") + " - " + utils.getDateFormatted(inputObject.limits.end, "HH:mm z") + "` period" + utils.flagsToString(inputObject.flags) + ", duration " + utils.humanTime(inputObject.duration / 1000) + ". Requested by " + getUserTagName(CurrentPlayingSound.user) + "." + (inputObject.played ? " Resuming from " + Math.round(inputObject.played / 1000) + " second!" : ""));
				else if (inputObject.mode.how == 'phrase') {
					//Get name of that user
					//let quotedUser = client.guilds.get(config.guildId).members.get()
					let userName = "<@" + inputObject.searchresult.author + ">";
					let guildUserName = db.getUserGuildName(inputObject.searchresult.author);
					if (guildUserName)
						userName = "**" + guildUserName + "**";
					playbackMessage(":speaking_head: Playing quote of " + userName + " `" + utils.getDateFormatted(inputObject.limits.start, "D MMM YYYY, HH:mm z") + "`" + utils.flagsToString(inputObject.flags) + ", duration " + utils.humanTime(inputObject.duration / 1000) + ". Requested by " + getUserTagName(inputObject.user) + "." + (inputObject.played ? " Resuming from " + Math.round(inputObject.played / 1000) + " second!" : ""));
				}
			}
			else if (inputObject.type == 'youtube') {
				playbackMessage(":musical_note: Playing Youtube `" + inputObject.title.substring(0, config.YoutubeTitleLengthLimit) + "`" + utils.flagsToString(inputObject.flags) + " (duration " + utils.humanTime(inputObject.duration) + "). Requested by " + getUserTagName(inputObject.user) + ". <" + inputObject.link + ">");
			}
		}
	}
	else
		utils.report("There was an error: empty input list for ffmpeg command.", 'r');
}

//Add sound to the playing queue
function addToQueue(soundToPlay, method = 'append') {
	//Append to the end of the queue
	if (method == 'append') {
		PlayingQueue.push(soundToPlay);
	}
	//Add as first element in the queue shifting all others
	else {
		PlayingQueue.unshift(soundToPlay);
	}
}

//Attach event listener to connection dispatcher when playback starts
function attachEventsOnPlayback(connection) {
	//What to do in the end of the playback
	connection.dispatcher.on('end', (reason) => {
		checkedDataStart = null;
		if (config.logging.ConsoleReport.SoundsPlaybackDebug) utils.report("Finished playing! Reason: " + reason, 'c', config.logging.LogFileReport.SoundsPlaybackDebug); //debug message
		soundIsPlaying = false;
		handleQueue(reason);
		LastPlaybackTime = Date.now();
		//Recreate player in 1 second if nothing else is playing and write stats to DB
		setTimeout(() => {
			if (!soundIsPlaying && !PreparingToPlaySound) {
				recreatePlayer();
				writeQueueToDB();
			}
		}, 1000);
	});
	connection.dispatcher.on('start', () => {
		//For debugging responce timings
		if (config.logging.ConsoleReport.DelayDebug) {
			utils.report(utils.msCount("Playback") + " Started playing!.", 'c', config.logging.LogFileReport.DelayDebug); //debug message
		} 
		if (config.logging.ConsoleReport.SoundsPlaybackDebug) utils.report("Started playing!", 'c', config.logging.LogFileReport.SoundsPlaybackDebug); //debug message
		PreparingToPlaySound = false;
		soundIsPlaying = true;
		//console.log(connection.player);
	});
	connection.dispatcher.on('speaking', (message) => {
		//For debugging responce timings
		if (config.logging.ConsoleReport.DelayDebug) {
			utils.report(utils.msCount("Playback", 'reset') + " Dispatcher debug: " + message, 'c', config.logging.LogFileReport.DelayDebug); //debug message
		}
	});
	connection.dispatcher.on('error', (error) => {
		if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("Playback", 'reset') + " Error playing!.", 'c', config.logging.LogFileReport.DelayDebug); //debug message
		utils.report('Dispatcher error while playing the file: ' + error, 'r');
		PreparingToPlaySound = false;
		soundIsPlaying = false;
		LastPlaybackTime = Date.now();
	});
}

//Playing next sound in the queue
function playQueue(connection) {
	if (config.logging.ConsoleReport.SoundsPlaybackDebug) utils.report("playQueue PASSED!", 'c', config.logging.LogFileReport.SoundsPlaybackDebug); //debug message
	if (!PreparingToPlaySound) {
		PreparingToPlaySound = true;
		if (config.logging.ConsoleReport.SoundsPlaybackDebug) utils.report("PreparingToPlaySound PASSED", 'c', config.logging.LogFileReport.SoundsPlaybackDebug); //debug message
			//First we check if we are on a channel
		if (connection.channel) {
			if (config.logging.ConsoleReport.SoundsPlaybackDebug) utils.report("connection.channel PASSED", 'c', config.logging.LogFileReport.SoundsPlaybackDebug); //debug message
				//If nothing is playing and there is still somethign in the queue
			if (!soundIsPlaying && PlayingQueue.length > 0) {
				if (config.logging.ConsoleReport.SoundsPlaybackDebug) utils.report("soundIsPlaying PASSED", 'c', config.logging.LogFileReport.SoundsPlaybackDebug); //debug message
				//Get next sound from the queue
				let inputObject = PlayingQueue.shift();
				let PlaybackOptions = {};
				//If it does not have a target, remember this command in the history
				if (!utils.get(inputObject, 'flags.target'))
					addHistoryPlaybackElement(inputObject);
				
				if (inputObject.type == 'file') {
					if (config.logging.ConsoleReport.SoundsPlaybackDebug) utils.report("inputObject.type PASSED", 'c', config.logging.LogFileReport.SoundsPlaybackDebug); //debug message
					CurrentPlayingSound = { 'type': 'file', 'path': path.resolve(__dirname, config.folders.Sounds, inputObject.filename), 'filename': inputObject.filename, 'duration': inputObject.duration, 'user': inputObject.user, 'flags': inputObject.flags };
					if (inputObject.played) CurrentPlayingSound['played'] = inputObject.played;
					CurrentVolume = inputObject.flags.volume ? calcVolumeToSet(inputObject.flags.volume) : calcVolumeToSet(db.getUserVolume(inputObject.user.id));
					PlaybackOptions = { 'volume': CurrentVolume, 'passes': config.VoicePacketPasses, 'bitrate': 'auto' };
					if (inputObject.played) PlaybackOptions['seek'] = inputObject.played / 1000;
					if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("Playback") + " Creating File dispatcher...", 'c', config.logging.LogFileReport.DelayDebug); //debug message

					queueDBWrite.push({ function: 'userPlayedSoundsInc', argument: inputObject.user.id });
					queueDBWrite.push({ function: 'soundPlayedInc', argument: inputObject.filename });
					//db.userPlayedSoundsInc(inputObject.user.id); //Increment value in DB for statistics
					//db.soundPlayedInc(inputObject.filename); //Increment value in DB for statistics

					//let ffstream = utils.processStream([{ file: path.resolve(__dirname, config.folders.Sounds, inputObject.filename) }], inputObject.flags, utils.get(inputObject, 'flags.target'));
					//connection.playConvertedStream(ffstream, PlaybackOptions);
					executeFFMPEG(connection, PlaybackOptions, inputObject, [{ file: path.resolve(__dirname, config.folders.Sounds, inputObject.filename) }]);
				}
				//QueueElement = { 'type': 'recording', 'searchresult': found, 'user': guildMember, 'flags': additionalFlags };
				else if (inputObject.type == 'recording') {
					if (inputObject.chunks) {
						//If its not the last chunk, add next one to the queue
						if (inputObject.chunkIndex < inputObject.chunks) {
							let nextChunkResult = db.makeRecFileList(inputObject.searchresult.endTime, inputObject.mode, config.SearchHoursPeriod * 3600000, inputObject.usersList);
							let QueueElement = { 'type': 'recording', 'searchresult': nextChunkResult, 'usersList': inputObject.usersList, 'mode': inputObject.mode, 'chunkIndex': inputObject.chunkIndex + 1, 'chunks': inputObject.chunks, 'user': inputObject.user, 'flags': inputObject.flags, 'duration': inputObject.duration };
							PlayingQueue.unshift(QueueElement);
						}
						utils.report('Playing next recording chunk #' + inputObject.chunkIndex + ' of ' + inputObject.chunks, 'g');
					}

					CurrentPlayingSound = { 'type': 'recording', 'searchresult': inputObject.searchresult, 'duration': inputObject.duration, 'user': inputObject.user, 'flags': inputObject.flags };
					
					CurrentVolume = inputObject.flags.volume ? calcVolumeToSet(inputObject.flags.volume) : calcVolumeToSet(db.getUserVolume(inputObject.user.id));
					PlaybackOptions = { 'volume': CurrentVolume, 'passes': config.VoicePacketPasses, 'bitrate': 'auto' };
					
					if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("Playback") + " Creating File dispatcher...", 'c', config.logging.LogFileReport.DelayDebug); //debug message

					queueDBWrite.push({ function: 'userPlayedRecsInc', argument: inputObject.user.id });
					//db.userPlayedRecsInc(inputObject.user.id); //Increment value in DB for statistics
					//let ffstream = utils.processStream(inputObject.searchresult.list, inputObject.flags, utils.get(inputObject, 'flags.target'), { how: inputObject.searchresult.method, channels: inputObject.searchresult.channelsToMix });
					//connection.playConvertedStream(ffstream, PlaybackOptions); 
					executeFFMPEG(connection, PlaybackOptions, inputObject, inputObject.searchresult.list, { how: inputObject.searchresult.method, channels: inputObject.searchresult.channelsToMix });
				}
				else if (inputObject.type == 'youtube') {
					let YtOptions = { quality: 'highestaudio' };
					let recievedInfo = false;
					let YTinfo = {};
					if (config.UseAudioOnlyFilterForYoutube) YtOptions['filter'] = 'audioonly';
					//'begin' parameter should be greather than 6 seconds: https://github.com/fent/node-ytdl-core/issues/129
					// sometimes its not working
					if (inputObject.played && inputObject.played > 7000 && !config.UseAudioOnlyFilterForYoutube) YtOptions['begin'] = Math.floor(inputObject.played / 1000) + "s";
					if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("Playback") + " creating stream... for '" + inputObject["link"]+"'", 'c', config.logging.LogFileReport.DelayDebug); //debug message

					queueDBWrite.push({ function: 'userPlayedYoutubeInc', argument: inputObject.user.id });
					//db.userPlayedYoutubeInc(inputObject.user.id); //Increment value in DB for statistics

					//Create the stream
					let stream = ytdl(inputObject["link"], YtOptions)
					stream.on('info', (videoInfo, videoFormat) => {
						if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("Playback") + " Recieved YouTube info message, creating dispatcher...", 'c', config.logging.LogFileReport.DelayDebug); //debug message
						CurrentPlayingSound = inputObject;
						CurrentPlayingSound.title = videoInfo['title'];
						CurrentPlayingSound.duration = videoInfo['length_seconds'];
						if (inputObject.played) CurrentPlayingSound['played'] = inputObject.played;
						CurrentVolume = inputObject.flags.volume ? calcVolumeToSet(inputObject.flags.volume) : calcVolumeToSet(db.getUserVolume(inputObject.user.id));
						PlaybackOptions = { 'volume': CurrentVolume, 'passes': config.VoicePacketPasses, 'bitrate': 'auto' };
						if (inputObject.played && config.UseAudioOnlyFilterForYoutube) {
							if (inputObject.played / 1000 <= config.YoutubeResumeTimeLimit)
								PlaybackOptions['seek'] = inputObject.played / 1000;
							else
								PlaybackOptions['seek'] = config.YoutubeResumeTimeLimit;
						}

						//let ffstream = utils.processStream([{ file: stream }], inputObject.flags, utils.get(inputObject, 'flags.target'));
						//connection.playConvertedStream(ffstream, PlaybackOptions);
						executeFFMPEG(connection, PlaybackOptions, CurrentPlayingSound, [{ file: stream }]);
						recievedInfo = true;
					});
					stream.on('error', error => {
						utils.report('Couldnt download video! Reason: ' + error, 'r');
						sendInfoMessage("There was an error while playing your YouTube link: " + error, client.channels.get(config.ReportChannelId), CurrentPlayingSound.user);
						if (stream)
							stream.end();
					});
					//In case something goes wrong and we never get 'info' event, we need to set variables back to normal
					setTimeout(() => {
						if (!recievedInfo && PreparingToPlaySound) {
							PreparingToPlaySound = false;
							if (stream)
								stream.end();
						}
					}, config.YoutubeInfoResponceTimeoutMs);
				}
				else {
					utils.report('ERROR! InputObject is wrong format, skipping. Contents: ' + JSON.stringify(inputObject), 'r');
					PreparingToPlaySound = false;
				}
			}
			else {
				PreparingToPlaySound = false;
			}
		}
	}
}

//Stop or Pause the sound
function stopPlayback(connection, checkForLongDuration = false, newFileDurationSec=0) {
	//Stop it, but add to the queue to play later from same position
	if (checkForLongDuration && CurrentPlayingSound) {
		let nowPlaying = CurrentPlayingSound;
		if (nowPlaying.type == 'file' && config.EnablePausingOfLongSounds && CurrentPlayingSound.duration >= config.LongSoundDuration && (newFileDurationSec > 0 && newFileDurationSec < config.LongSoundDuration)) {
			nowPlaying['played'] = CurrentPlayingSound.played ? connection.dispatcher.time + CurrentPlayingSound.played : connection.dispatcher.time;
			
			PlayingQueue.unshift(nowPlaying);
		}
		else if (nowPlaying.type == 'recording' && PlayingQueue[0] && !checkForLongDuration) {
			if (PlayingQueue[0].chunkIndex)
				PlayingQueue.shift();
		}
	}
	//End the playback
	if (connection.dispatcher) {
		if (connection.dispatcher.stream) {
			connection.dispatcher.end();
			//connection.dispatcher.stream.destroy();
		}
		//connection.dispatcher.end();
	}
	//Kill all ffmpeg Playback processes
	deletePlaybackCommands();
}

function addHistoryPlaybackElement(element) {
	lastQueueElements.unshift(element);
	if (lastQueueElements.length > config.PlaybackHistoryLastSize)
		lastQueueElements.pop();
}

//Check if we need to launch next sound in the queue
function handleQueue(reason) {
	if (config.logging.ConsoleReport.DelayDebug) utils.msCount("Playback", 'start'); //debug message (not printing)
	if (!PreparingToPlaySound && !PausingThePlayback) {
		setTimeout(() => {
			if (config.logging.ConsoleReport.DelayDebug) utils.msCount("Playback"); //debug message (not printing)
			let currConnection = getCurrentVoiceConnection();
			if (currConnection) {
				playQueue(currConnection);
			}
		}, (Date.now() - LastPlaybackTime >= config.SoundPlaybackWaitTimeMs ? 0 : config.SoundPlaybackWaitTimeMs - (Date.now() - LastPlaybackTime)));
	}
	if (PausingThePlayback)
		PausingThePlayback = false;
}


// =============== CLIENT EVENTS ===============

client.on('ready', () => {
	utils.report('Logged in as ' + client.user.tag + '!', 'g');
	if (config.guildId && config.ReportChannelId)
		db.updateUsersDB(client.guilds.get(config.guildId).members);
	else
		utils.report("Looks like 'guildId' and 'ReportChannelId' options are not set. To set them, please edit config.js file or type '"+config.CommandCharacter+"register' on the report channel of your server.\nBot will not function untill you do this. Waiting for command...", 'y');
	BotReady = true;
});
/*client.on('debug', (message) => {
	utils.report('DDebug: ' + message, 'w');
	BotReady = true;
});*/
client.on('reconnecting', () => {
	utils.report("Trying to reconnect... ", 'y');
	BotReady = false;
});
client.on('error', error => {
	utils.report("Connection problem: " + error, 'y');
	//BotReady = false;
});
client.on('warn', error => utils.report("Warning: " + error, 'y'));

//Renew guild members on join and update (otherwise we have old names and non-existant members in client.guilds)
client.on('guildMemberAdd', member => {
	if (!config.guildId || !config.ReportChannelId) return;
	client.guilds.get(config.guildId).fetchMember(member.id)
		.then(() => {
			if (config.logging.ConsoleReport.MembersJoiningUpdating) utils.report("New Member joined: '" + member.user.username + "' (" + member.id + ")!", 'b', config.logging.LogFileReport.MembersJoiningUpdating);
			db.userUpdateAdd(member.id, member.user.username, member.nickname, config.DefaultVolume);
		})
		.catch(error => utils.report("Couldn't fetch a new member '" + member.user.username +"'. Error: " + error, 'r'));
});
client.on('guildMemberUpdate', (OldMember, NewMember) => {
	if (!config.guildId || !config.ReportChannelId) return;
	client.guilds.get(config.guildId).fetchMember(NewMember.id)
		.then(() => {
			if (config.logging.ConsoleReport.MembersJoiningUpdating) utils.report("Member updated: '" + NewMember.user.username + "' (" + NewMember.id + ")!", 'b', config.logging.LogFileReport.MembersJoiningUpdating);
			db.userUpdateAdd(NewMember.id, NewMember.user.username, NewMember.nickname, config.DefaultVolume);
		})
		.catch(error => utils.report("Couldn't fetch a member update for '" + NewMember.user.username + "'. Error: " + error, 'r'));
});

//Check if bot should move to this channel or leave it if required amount of members in there is reached
client.on('voiceStateUpdate', (OldMember, NewMember) => {
	if (!config.guildId || !config.ReportChannelId) return;
	//react only to our guild events
	if (NewMember.guild.id == config.guildId || OldMember.guild.id == config.guildId) {
		let userName = getUserName(NewMember.user)
		let currConnection = getCurrentVoiceConnection();

		//Member joined a voice channel
		if (!(OldMember.voiceChannelID) && NewMember.voiceChannelID) {
			let ChannelMembersCount = countChannelMembers(NewMember.voiceChannel);
			if (config.logging.ConsoleReport.MembersJoinLeaveVoice) utils.report(userName + " joined '" + NewMember.voiceChannel.name + "' channel!", 'w', config.logging.LogFileReport.MembersJoinLeaveVoice);
			db.AddUserActivity(NewMember.user.id, NewMember.voiceChannel.id, 0, ChannelMembersCount);
			if (ChannelMembersCount >= config.AutoJoinMembersAmount && config.AutoJoinTalkingRoom) {
				if (config.logging.ConsoleReport.ChannelMembersCountDebug) utils.report("Members count: There are " + countChannelMembers(NewMember.voiceChannel) + " members in '" + NewMember.voiceChannel.name + "' channel now. (By config we join if >" + config.AutoJoinMembersAmount + ").", 'c', config.logging.LogFileReport.ChannelMembersCountDebug); //debug message
				if (currConnection && config.SwitchVoiceRoomIfMoreMembers) {
					//Change the channel if it has more members than current one
					if (countChannelMembers(NewMember.voiceChannel) > countChannelMembers(currConnection.channel) && NewMember.voiceChannel.joinable)
						joinVoiceChannelQueue(NewMember.voiceChannel);
				}
				else if (!currConnection && NewMember.voiceChannel.joinable)
					//If we dont have any active channel connections
					joinVoiceChannelQueue(NewMember.voiceChannel);

			}
		}
		//Member Left a voice channel
		else if (OldMember.voiceChannelID && !(NewMember.voiceChannelID)) {
			let ChannelMembersCount = countChannelMembers(OldMember.voiceChannel);
			let channel = OldMember.voiceChannel;
			if (config.logging.ConsoleReport.MembersJoinLeaveVoice) utils.report(userName + " left '" + OldMember.voiceChannel.name + "' channel!", 'w', config.logging.LogFileReport.MembersJoinLeaveVoice);
			db.AddUserActivity(NewMember.user.id, OldMember.voiceChannel.id, 1, ChannelMembersCount);
			//Leave the channel if its empty
			if (currConnection) {
				if (countChannelMembers(currConnection.channel) == 0 && config.AutoLeaveIfAlone) {
					//If there is no ChannelJoin command in the queue
					if (!ChannelWaitingToJoin) {
						stopPlayback(currConnection, false);
						recieversDestroy();
					}
				}

			}
		}
		//Member changed a voice channle
		else if (OldMember.voiceChannelID != NewMember.voiceChannelID && OldMember.voiceChannelID && NewMember.voiceChannelID) {
			if (config.logging.ConsoleReport.MembersJoinLeaveVoice) utils.report(userName + " switched to '" + NewMember.voiceChannel.name + "' channel!", 'w', config.logging.LogFileReport.MembersJoinLeaveVoice);
			db.AddUserActivity(NewMember.user.id, NewMember.voiceChannel.id, 2, countChannelMembers(NewMember.voiceChannel));
			if (currConnection && (config.SwitchVoiceRoomIfMoreMembers || countChannelMembers(currConnection.channel) == 0)) {
				//Change the channel if it has more members than current one
				if ((countChannelMembers(NewMember.voiceChannel) > countChannelMembers(currConnection.channel) || countChannelMembers(currConnection.channel) == 0) && NewMember.voiceChannel.id != currConnection.channel.id && NewMember.voiceChannel.joinable)
					joinVoiceChannelQueue(NewMember.voiceChannel);
			}
			else if (!currConnection && NewMember.voiceChannel.joinable)
				//If we dont have any active channel connections
				joinVoiceChannelQueue(NewMember.voiceChannel);
		}
	}
});

//Start DB and read config options
if (utils.checkFoldersExistance()) {
	db.prepareDatabase()
		.then(() => {
			db.readOptionsFromDB();
			opt.readOptionsFromConfig();

			checkCiticalConfigValues();
				
		})
		.catch(err => { utils.report("There was an error while preparing the database: " + err, 'r'); });

}
//Check if critical options are set
function checkCiticalConfigValues() {
	if (config.token)
		mainStart();
	else {
		let tokenIsSet = false;
		const readline = require('readline');
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout
		});

		function askForToken() {
			return new Promise((resolve, reject) => {
				rl.question('\n\nTThere is no token record in config.js file. Please, either set it in config.js or paste it here.\nWhat is the bot token?\n', (answer) => {
					if (answer.length > 5) {
						db.writeOption('token', answer.trim());
						rl.close();
						return resolve(false);
					}
					else {
						console.log("Token is too short! Try again.");
						askForToken()
							.then(err => {
								return resolve(err);
							});
						
					}

				});
			});
		}

		askForToken()
			.then(err => {
				rl.close();
				mainStart();
			});
		
	}
}
//Start bot if everything is ready
function mainStart() {
	db.scanSoundsFolder()
		.then(() => {
			db.checkRecordingsScanNeeded()
				.then(err => {
					if (!err)
						RecordsDBReady = true;
					client.login(config.token);
				});
		});
}

//Register on a server or change report channel
function registerGuildChannel(guildId, channelId, userId) {
	db.writeOption('guildId', guildId);
	db.writeOption('ReportChannelId', channelId);
	db.updateUsersDB(client.guilds.get(config.guildId).members);
	utils.report("Registering guildId: " + guildId + ", ReportChannelId: " + channelId + "!", 'g');
}

// =============== MESSAGE EVENTS ===============
client.on('message', async message => {
	//If guild was not registered yet
	if (!config.guildId || !config.ReportChannelId) {
		if (message.content == config.CommandCharacter + "register") {
			registerGuildChannel(message.guild.id, message.channel.id, message.author.id);
		}
		return;
	}
	let userName = getUserName(message.author)
	let guildMember = message.channel.type != "text" ? client.guilds.get(config.guildId).members.get(message.author.id) : message.member;
	let currVoiceConnection = getCurrentVoiceConnection();
	guildMember.roles.array()
	if (userName && guildMember) {
		//Only handle commands from our guild or direct messages from members of our guild
		if (message.channel.type != 'dm' && message.channel.guild) if (message.channel.guild.id != config.guildId) return;
			//If its a command
			if (message.content.substring(0, config.CommandCharacter.length) == config.CommandCharacter) {
				let args = message.content.substring(config.CommandCharacter.length).split(' ');
				let additionalFlags = utils.readFlags(message.content);
                //let additionalFlags = {};
				let command = args[0].toLowerCase();
				args = args.splice(1);

				if (config.RestrictCommandsToSingleChannel && message.channel.id == config.ReportChannelId || config.ReactToDMCommands && message.channel.type == 'dm' || !config.RestrictCommandsToSingleChannel) {
					utils.report("Command from " + userName + ": " + message.content.replace(/(\r\n\t|\n|\r\t)/gm, " "), 'm');

					switch (command) {
						case 'scan':
						case 'rescan':
							{
								if (config.EnableSoundboard && checkPermission(guildMember, 30)) {
									if (["sess", "sessions", "talk", "talks"].indexOf(args[0].toLowerCase()) > -1) {
										sendInfoMessage("Recalcuating talk sessions...", message.channel, message.author);
										setTimeout(() => {
											db.calculateTalksList(config.GapForNewTalkSession * 60000, 0, 0, 0, [], true)
												.then(() => {
													sendInfoMessage("Recalcuation of talk sessions is done!", message.channel, message.author);
												});
										}, 200);
									}
									else if (["phrases", "phrase", "quotes"].indexOf(args[0].toLowerCase()) > -1) {
										sendInfoMessage("Recalcuating phrases", message.channel, message.author);
										setTimeout(() => {
											db.scanForPhrases()
												.then((err) => {
													sendInfoMessage("Recalcuation of phrases is done!", message.channel, message.author);
												});
										}, 200);
									}
									else {
										sendInfoMessage("Scanning sound files...", message.channel, message.author);
										setTimeout(() => {
											db.scanSoundsFolder();
										}, 200);
									}
								}
								break;
							}
						case 'register':
							{
								if (checkPermission(guildMember, 30)) {
									registerGuildChannel(message.guild.id, message.channel.id, message.author.id);
									sendInfoMessage("Registring new ReportChannelId!", message.channel, message.author);
								}
								break;
							}
						case 'shutdown':
						case 'poweroff':
						case 'logout':
							{
								if (checkPermission(guildMember, 30)) {
									sendInfoMessage("Bot shuts down. See you! :wave:", message.channel, message.author);
									setTimeout(() => {
										handleExitEvent();
									}, 1000);
								}
								break;
							}
						case 'help':
							{
								//Send in private chat
								message.author.send("Help message")
								break;
							}
						//Give list of possible files to play
						case 'list':
						case 'files':
							{
								if (config.EnableSoundboard && checkPermission(guildMember, 6, message.channel)) {
									if (message.channel.type != "dm")
										sendInfoMessage("List sent in private!", message.channel);
									db.getSoundsList()
										.then(found => {
											let resultList = "";
											for (i in found) {
												resultList += config.CommandCharacter + found[i] + "\n";
											}
											let beginMessage = "This is the list of all avaliable sound files. Type any of the following commands or part of it to play the file: ";
											messagesToSend = breakMessage(resultList, beginMessage.length, "```", "```");
											//resultList = "This is the list of all avaliable sound files. Type any of the following commands or part of it to play the file: ```" + resultList + "```";
											for (i in messagesToSend) {
												let thisChunk = (i == 0 ? beginMessage : "") + messagesToSend[i];
												message.author.send(thisChunk)
													.then(message => { if (i == 0) utils.report("Sent list of possible commands to '" + userName + "' user (" + message.author.id + ").", 'y'); })
													.catch(error => utils.report("Error sending message to '" + userName + "' user (" + message.author.id + "). Reason: " + error, 'r'));
											}
										});
								}
								break;
							}
						//Summon bot to the voiceChannel
						case 'summon':
						case 'summonbot':
						case 'bot':
						case 'join':
							{
								if ((config.EnableSoundboard || config.EnableRecording) && checkPermission(guildMember, 0, message.channel)) {
									if (guildMember.voiceChannel) {
										let playAfterRejoining = soundIsPlaying;
										if (currVoiceConnection) {
											if (currVoiceConnection.channel.id != guildMember.voiceChannel.id) {
												//Pause the playback if any
												if (soundIsPlaying && currVoiceConnection) {
													PausingThePlayback = true;
													stopPlayback(currVoiceConnection, true);

												}
											}
											else
												sendInfoMessage("I'm already on the channel! :angry:", message.channel, message.author);
										}
										if (getVoiceChannel(guildMember).joinable)
											//Join the channel
											checkChannelJoin(guildMember.voiceChannel)
												.then((connection) => {
													//Play the sound if there were any
													if (playAfterRejoining)
														handleQueue('PlayAfterRejoining');
												})
												//We couldnt join the channel, throw message on a log channel about it
												.catch(error => {
													utils.report("Couldn't join channel. Error: " + error, 'r');
													sendInfoMessage("I couldn't join your channel! :sob:", message.channel, message.author);
												});

									}
									else
										sendInfoMessage("Join a voice channel first!", message.channel, message.author);
								}
								break;
							}
						//Delete or rename a sound
						case 'delete':
						case 'del':
						case 'rename':
						case 'ren':
						case 'remove':
							{
								if (config.EnableSoundboard) {
									if (checkForEmptyArguments(args, message.channel, message.author)) return;

									db.findSound(args[0])
										.then(found => {
											if (found.count == 1) {
												let RenameLocalAudioFiles = checkPermission(guildMember, 10, message.channel, false);
												let DeleteLocalAudioFiles = checkPermission(guildMember, 5, message.channel, false);
												let DeleteOwnLocalAudioFiles = checkPermission(guildMember, 17, message.channel, false);
												let RenameOwnLocalAudioFiles = checkPermission(guildMember, 18, message.channel, false);
												let ownCommand = found.sound.uploadedBy == message.author.id;
												//Rename a command
												if (command == 'rename' || command == 'ren') {
													if (!args[1]) {
														sendInfoMessage("You didn't specify second argument. \nTo rename a command you need to use two arguments: `" + config.CommandCharacter + "rename old_command new_command`", message.channel, message.author);
														return;
													}
													if (!ownCommand && RenameOwnLocalAudioFiles && !RenameLocalAudioFiles) {
														sendInfoMessage("You did not upload this command and therefore have no permission to rename it.", message.channel, message.author);
														return;
													}
													else if (!RenameOwnLocalAudioFiles && !RenameLocalAudioFiles) {
														sendInfoMessage("You have no permission to rename commands.", message.channel, message.author);
														return;
													}
													let newName = utils.sanitizeFilename(args[1]);

													if (RenameLocalAudioFiles || (RenameOwnLocalAudioFiles && ownCommand)) {
														utils.moveFile(path.resolve(__dirname, config.folders.Sounds, found.sound.filenameFull), path.resolve(__dirname, config.folders.Sounds, newName + found.sound.extension), false)
															.then(() => {
																db.renameSound(found.sound.filenameFull, newName + found.sound.extension, newName, found.sound.extension);
																sendInfoMessage("Successfully renamed command `" + found.sound.filename + "` into `" + newName + "`.", message.channel, message.author);
															})
															.catch(err => {
																utils.report("Couldn't rename file '" + path.resolve(__dirname, config.folders.Sounds, found.sound.filenameFull) + "' into '" + path.resolve(__dirname, config.folders.Sounds, newName + found.sound.extension) + "'. " + err, 'r');
																sendInfoMessage("There was an error while performing file rename operation.", message.channel, message.author);
															});
													}
												}
												//Delete a command
												else {
													if (!ownCommand && DeleteOwnLocalAudioFiles && !DeleteLocalAudioFiles) {
														sendInfoMessage("You did not upload this command and therefore have no permission to delete it.", message.channel, message.author);
														return;
													}
													else if (!DeleteOwnLocalAudioFiles && !DeleteLocalAudioFiles) {
														sendInfoMessage("You have no permission to delete commands.", message.channel, message.author);
														return;
													}

													if (DeleteLocalAudioFiles || (ownCommand && DeleteOwnLocalAudioFiles)) {
														let newFilename = utils.incrementFilename(found.sound.filenameFull, config.folders.DeletedSounds);
														utils.moveFile(path.resolve(__dirname, config.folders.Sounds, found.sound.filenameFull), path.resolve(__dirname, config.folders.DeletedSounds, newFilename), false)
															.then(() => {
																db.deleteSound(found.sound.filenameFull);
																sendInfoMessage("Successfully deleted command `" + found.sound.filename + "`.", message.channel, message.author);
															})
															.catch(err => {
																utils.report("Couldn't rename file '" + path.resolve(__dirname, config.folders.Sounds, found.sound.filenameFull) + "' into '" + path.resolve(__dirname, config.folders.Sounds, newName + found.sound.extension) + "'. " + err, 'r');
																sendInfoMessage("There was an error while deleting file.", message.channel, message.author);
															});
													}
												}
											}
											else if (found.count>1)
												sendInfoMessage("More than one result is found. Please, type a full command.", message.channel, message.author);
											else
												sendInfoMessage("Nothing was found. Type `" + config.CommandCharacter + "list` to see full list of avaliable commands.", message.channel, message.author);
										});
								}
								break;
							}
						//Dismiss
						case 'dismiss':
						case 'leave':
						case 'quit':
							{
								if ((config.EnableSoundboard || config.EnableRecording) && checkPermission(guildMember, 1, message.channel)) {
									if (currVoiceConnection) {
										//First, pause any playback
										if (soundIsPlaying) 
											stopPlayback(currVoiceConnection, true);
										
										//Delete all voice connections
										recieversDestroy();
									}
									else
										sendInfoMessage("I'm not on a channel!", message.channel, message.author);
								}
								break;
							}
						//Play (if something was paused before)
						case 'play':
						case 'start':
						case 'proceed':
							{
								if (config.EnableSoundboard && checkPermission(guildMember, 7, message.channel)) {
									if (!soundIsPlaying) {
										if (PlayingQueue.length > 0) {
											if (currVoiceConnection) {
												handleQueue('PlayCommand');
												playbackMessage(":arrow_forward: Starting the queue (requested by " + getUserTagName(message.author) + ").");
											}
											else {
												sendInfoMessage("I dont know where to play. Use **" + config.CommandCharacter + "summon** command first!", message.channel, message.author);
											}
										}
										else {
											sendInfoMessage("There is nothing in the queue :sob:", message.channel, message.author);
										}

									}
									else {
										sendInfoMessage("Something is being played already! Use **" + config.CommandCharacter + "help** command to see instructions on how to use this bot.", message.channel, message.author);
									}
								}
								break;
							}
						//Play last element
						case 'last':
						case 'repeat':
						case 'again':
							{
								if (config.EnableSoundboard) {
									if (checkPermission(guildMember, 16, message.channel)) {
										prepareForPlaybackOnChannel(guildMember)
											.then((connection) => {
												if (connection) {
													if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("repeatCommand") + " Checked channel presence.", 'c', config.logging.LogFileReport.DelayDebug); //debug message
													let QueueElement = null;
													if (!isNaN(args[0])) {
														let index = Number(args[0]) > config.PlaybackHistoryLastSize ? config.PlaybackHistoryLastSize : Number(args[0]) < 1 ? 0 : Number(args[0]) - 1;
														if (lastQueueElements.length > 0 && lastQueueElements.length >= index + 1)
															QueueElement = lastQueueElements.splice(index)[0];
														else
															sendInfoMessage("Nothing found!", message.channel, message.author);
													}
													else {
														if (lastQueueElements.length > 0)
															QueueElement = lastQueueElements.shift();
														else
															sendInfoMessage("History is empty!", message.channel, message.author);
													}
													if (QueueElement) {
														QueueElement.user = guildMember;
														//Replace flags with new ones
														for (var key in additionalFlags) if (additionalFlags[key] && additionalFlags[key] != NaN) QueueElement.flags[key] = additionalFlags[key];
														//If something is playing right now
														if (soundIsPlaying) {
															if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("repeatCommand") + " Stopping playback.", 'c', config.logging.LogFileReport.DelayDebug); //debug message
															//Stop or pause the playback (depending on length of playing sound)
															stopPlayback(connection, true);
															//Add to the front position in queue
															PlayingQueue.unshift(QueueElement);
															//Do not run handleQueue() here, since it will be run due to dispatcher.end Event after stopping the playback
														}
														//Nothing is playing right now
														else {
															if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("repeatCommand", 'reset') + " Launching handleQueue().", 'c', config.logging.LogFileReport.DelayDebug); //debug message
															PlayingQueue.unshift(QueueElement);
															handleQueue('repeatRequest');
														}
													}
												}
											});
									}
								}
								break;
							}
						//Pause the playback
						case 'pause':
						case 'hold':
						case 'wait':
							{
								if (config.EnableSoundboard && checkPermission(guildMember, 7, message.channel)) {
									if (soundIsPlaying && currVoiceConnection) {
										PausingThePlayback = true;
										stopPlayback(currVoiceConnection, true);
										playbackMessage(":pause_button: Playback paused (requested by " + getUserTagName(message.author) + ").");
									}
								}
								break;
							}
						//Rejoin the channel (Leave and join again - sometimes people cant hear the bot, usually this helps)
						case 'rejoin':
						case 'resummon':
						case 'restart':
							{
								if ((config.EnableSoundboard || config.EnableRecording) && checkPermission(guildMember, 8, message.channel)) {
									let playAfterRejoining = soundIsPlaying;
									if (guildMember.voiceChannel) {
										//First, pause any playback
										if (soundIsPlaying && currVoiceConnection) {
											stopPlayback(currVoiceConnection, true);
										}
										//Delete all voice connections first
										recieversDestroy();
										//Make sure wo wait before joining
										LastChannelChangeTimeMs = Date.now();
										if (guildMember.voiceChannel.joinable)
											//Join the channel again
											checkChannelJoin(guildMember.voiceChannel)
												.then((connection) => {
													utils.report("Successfully rejoined the channel '" + guildMember.voiceChannel.name + "' (requested by " + userName + ").", 'g');
													//Play the sound if there were any
													if (playAfterRejoining)
														handleQueue('PlayAfterRejoining');
												})
												//We couldnt join the channel, throw message on a log channel about it
												.catch(error => {
													utils.report("Couldn't join channel. Error: " + error, 'r');
												});
									}
									else
										sendInfoMessage("Join a voice channel first!", message.channel, message.author);
								}
								break;
							}
						//Change the volume
						case 'v':
						case 'volume':
						case 'loudness':
						case 'vol':
							{
								if (config.EnableSoundboard) {
									let volumeToSet = 20;
									if (!isNaN(args[0]) && args[0] > 0 && (args[0] <= 100 || checkPermission(guildMember, 11, message.channel)))
										volumeToSet = args[0];
									//If sound is playing, change its volume
									if (soundIsPlaying) {
										let oldVolume = Math.round(CurrentVolume * 100 / (config.VolumeBotGlobal / 100));
										setVolume(calcVolumeToSet(volumeToSet), 1000);
										playbackMessage(((volumeToSet > oldVolume) ? ":loud_sound:" : ":sound:") + " " + getUserTagName(message.author) + " changed volume from " + oldVolume + "% to " + volumeToSet + "%.");
									}
									else
										sendInfoMessage("Setting your personal volume to " + args[0] + "%! Old value was " + db.getUserVolume(message.author.id) + "%.", message.channel, message.author);
									//Set member's personal volume level to this amount
									db.setUserVolume(message.author.id, volumeToSet);
								}
								break;
							}
						//Stop the playback and clear the queue if there are any elements
						case 'stop':
						case 'cancel':
						case 'end':
							{
								if (config.EnableSoundboard && checkPermission(guildMember, 9, message.channel)) {
									let queueDuration = getQueueDuration();
									let queueElements = PlayingQueue.length;
									//Check if we have any voiceConnections
									if (currVoiceConnection) {
										if (soundIsPlaying) {
											stopPlayback(currVoiceConnection, false);
											utils.report(userName + " stopped the playback! (command: '" + message.content + "')" + (queueElements > 0 ? " There were " + queueElements + " records in the queue with total duration of " + utils.humanTime(queueDuration) : ""), 'y');
											playbackMessage(":stop_button: Playback stopped by " + getUserTagName(message.author) + "." + (queueElements > 0 ? " There were " + queueElements + " records in the queue with total duration of " + utils.humanTime(queueDuration) + "." : ""));
										}
										else {
											utils.report("Nothing is playing, clearing the queue." + (queueElements > 0 ? " There were " + queueElements + " records in the queue with total duration of " + utils.humanTime(queueDuration/1000) : ""), 'y');
										}
									}
									PlayingQueue = [];

									////Heap dumb
									//setTimeout(() => {
									//	heapdump.writeSnapshot('/root/JS_DRaSB_' + Date.now() + '.heapsnapshot', (err, file) => {
									//		utils.report("Written dumb file to " + file + "!" , 'y');
									//	});
									//}, 2000);
								}
								break;
							}
						case 'talks':
						case 'chats':
						case 'sessions':
						case 'recordings':
							{
								let talkList = db.getTalksList();
								let allFlag = args.length ? args[0].toLowerCase() == "all" : false;
								let begin = "__There are " + talkList.talks + " talk sessions with total recorded voice duration of " + utils.humanTime(talkList.totalDuration / 1000) + ":__" + (!allFlag ? " Showing last sessions. To see all use `" + config.CommandCharacter + "talks all` command" : "") + "\n";
								let messageToSend = "";
								for (i in talkList.result)
									messageToSend += talkList.result[i] + "\n";
								let footer = "**Duration** is covered time of the session, **Playback** is total voice duration.";
								if (allFlag) {
									let msgs = breakMessage(messageToSend, footer.length + begin.length, "", "");
									sendInfoMessage("List of all sessions may be too long, therefore it's sent in private!", message.channel);
									for (i in msgs)
										message.author.send((i == 0 ? begin : "") + msgs[i] + (Number(i) + 1 == msgs.length ? footer : ""));
								}
								else {
									let msgs = breakMessage(messageToSend, footer.length + begin.length, "", "", true);
									message.channel.send(begin + msgs[0] + footer);
								}
								
								break;
							}
						//Play recording
						case 'rec':
                        case 'playrec':
						case 'quote':
						case 'r':
						case 'random':
							{
								if (config.EnableSoundboard) {
                                    
                                    if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("RecPlayCommand", 'start') + " Recieved command!", 'c', config.logging.LogFileReport.DelayDebug); //debug message
                                    //Get list of users that were mentioned
                                    let users = message.content.match(/([0-9]{9,})/gm);
									if (!users) users = [];
									let sessionInfo = null;
									if (additionalFlags['id'])
										sessionInfo = db.getTalkSession(additionalFlags['id']);

									let sequenceMode = true;
									//If there is 'id' then use sessionInfo data, else if no date, use 'ago' time, else use random
									let reqDate = sessionInfo ? sessionInfo.startTime-1 :
										additionalFlags['date'] ? additionalFlags['date'].getTime() :
										(additionalFlags['start'] ? Date.now() - additionalFlags['start'] * 1000 :
											additionalFlags['timetag'] ? Date.now() - additionalFlags['timetag'] * 1000 : 0);

									//Get user permissions
									let userPresence = db.CheckUserPresence(message.author.id, reqDate);
									let permPlayIfWasOnChannel = checkPermission(guildMember, 13, message.channel, false);
									let permPlayAnyonesRecord = checkPermission(guildMember, 14, message.channel, false);
									let permPlayRandomQuote = checkPermission(guildMember, 15, message.channel, false);

									//If user does not have permission to playback whole duration, cut it
									let endTime = 0;
									if (!permPlayAnyonesRecord && permPlayIfWasOnChannel && userPresence.presented) {
										endTime = sessionInfo ? sessionInfo.endTime > userPresence.left ? userPresence.left : sessionInfo.endTime : 0;
									}

                                    //If there is no exact date, no start mark and no timetag, or command is quote => make it 'phrase'
									if (!additionalFlags['date'] && !additionalFlags['timetag'] && !additionalFlags['id'] && !additionalFlags['start'] || command == 'random' || command == 'r')
										sequenceMode = false;
									
									//If specified duration is withing the limit, use it, otherwise use default value from config
									let duration = sequenceMode ?
										additionalFlags['duration'] > 0 && (additionalFlags['duration'] < config.MaximumDurationToPlayback || config.MaximumDurationToPlayback == 0) ? additionalFlags['duration'] * 1000 : sessionInfo ? sessionInfo.duration*1.5 : config.DefaultRecPlaybackDuration * 1000 :
										additionalFlags['timetag'] ? additionalFlags['timetag'] : additionalFlags['duration'] > 0 ? additionalFlags['duration']*1000 : config.PhraseMsDuration;
									
									let mode = sequenceMode ?
										{ how: 'sequence', duration: duration, gapToStop: config.GapForNewTalkSession * 60000, gapToAdd: config.GapsBetweenSayingsMs, endTime: endTime } :
										{ how: 'phrase', minDuration: duration, allowedGap: config.PhraseAllowedGapMsTime, gapToAdd: config.GapsBetweenSayingsMs };
									
									if (!sequenceMode && permPlayRandomQuote ||
										(sequenceMode && (userPresence.presented && permPlayIfWasOnChannel || permPlayAnyonesRecord))) {
										
										let found = db.makeRecFileList(reqDate, mode, config.SearchHoursPeriod * 3600000, users);

										if (found) {
											prepareForPlaybackOnChannel(guildMember)
												.then((connection) => {
													if (connection) {
														if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("RecPlayCommand") + " Checked channel presence.", 'c', config.logging.LogFileReport.DelayDebug); //debug message

														if (sequenceMode) {
															mode.duration = config.RecPlaybackChunkDuration * 1000;
															let firstChunk = db.makeRecFileList(found.startTime - 1, mode, config.SearchHoursPeriod * 3600000, users);
															//Create Queue element
															QueueElement = { 'type': 'recording', 'searchresult': firstChunk, 'mode': mode, 'limits': { start: found.startTime, end: found.endTime }, 'usersList': users, 'chunkIndex': 1, 'chunks': Math.ceil(found.duration / (config.RecPlaybackChunkDuration * 1000)), 'user': guildMember, 'flags': additionalFlags, 'duration': found.duration };
														}
														else {
															//Create Queue element
															QueueElement = { 'type': 'recording', 'searchresult': found, 'mode': mode, 'limits': { start: found.startTime, end: found.endTime }, 'usersList': users, 'user': guildMember, 'flags': additionalFlags, 'duration': found.duration };
														}
														//If something is playing right now
														if (soundIsPlaying) {
															if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("RecPlayCommand") + " Stopping playback.", 'c', config.logging.LogFileReport.DelayDebug); //debug message
															//Stop or pause the playback (depending on length of playing sound)
															stopPlayback(connection, true);
															//Add to the front position in queue
															PlayingQueue.unshift(QueueElement);
															//Do not run handleQueue() here, since it will be run due to dispatcher.end Event after stopping the playback
														}
														//Nothing is playing right now
														else {
															if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("RecPlayCommand", 'reset') + " Launching handleQueue().", 'c', config.logging.LogFileReport.DelayDebug); //debug message
															PlayingQueue.unshift(QueueElement);
															handleQueue('newSoundRequest');
														}
													}
												});
										}
										else
											sendInfoMessage("Nothing was found.", message.channel, message.author);
									}
									else {
										if (!sequenceMode && !permPlayRandomQuote)
											sendInfoMessage("You don't have permission to play random quotes.", message.channel, message.author);
										else if (sequenceMode && userPresence.presented && !permPlayIfWasOnChannel && !permPlayAnyonesRecord)
											sendInfoMessage("You were not on the channel at that time and have no permission to playback this.", message.channel, message.author);
										else
											sendInfoMessage("You don't have permission for that.", message.channel, message.author);
									}
                                }
                                break;
							}
						//Add element to the queue
						case 'q':
						case 'queue':
						case 'add':
						case 'append':
						case 'queueadd':
						case 'addnext':
							{
								if (config.EnableSoundboard) {
									if (checkForEmptyArguments(args, message.channel, message.author)) return;
									//This is Youtube link
									if (ytdl.validateURL(args[0]) && checkPermission(guildMember, 3, message.channel)) {
										ytdl.getBasicInfo(args[0], (err, info) => {
											if (err) {
												sendInfoMessage("Couldn't get video information from the link that you provided! Try other link.", message.channel, message.author);
												utils.report("ytdl.getBasicInfo failed, can't get youtube info from link: " + err, 'y');
											}
											else {
												playbackMessage(":arrow_right: " + getUserTagName(message.author) + " added Youtube link to the queue: `" + info['title'].substring(0, config.YoutubeTitleLengthLimit) + "` (duration " + utils.humanTime(info['length_seconds']) + "). <" + args[0] + ">");
												//Create Queue element
												QueueElement = { 'type': 'youtube', 'link': args[0], 'title': info['title'], 'video_id': info['video_id'], 'user': guildMember, 'duration': info['length_seconds'], 'loudness': info['loudness'], 'flags': additionalFlags };
												//Add to the queue
												PlayingQueue.push(QueueElement);
											}
										});
									}
									//This is probably a file
									else if (checkPermission(guildMember, 2, message.channel)) {
										db.findSound(command)
											.then(found => {
												if (found.count == 1 || (!config.StrictAudioCommands && found.count > 1)) {
													playbackMessage(":arrow_right: " + getUserTagName(message.author) + " added file to the queue: '" + found[0] + "'" + utils.flagsToString(additionalFlags) + " (duration " + utils.humanTime(db.getSoundDuration(found[0])) + ").");
													
													//Create Queue element
													QueueElement = { 'type': 'file', 'filename': found.sound.filenameFull, 'user': guildMember, 'duration': found.sound.duration, 'flags': additionalFlags };
													//Add to the queue
													PlayingQueue.push(QueueElement);
												}
												else if (found.count > 1)
													sendInfoMessage("More than one result found!", message.channel, message.author);
												else
													sendInfoMessage("There is no file with such name!", message.channel, message.author);
											});
									}
								}
								break;
							}
						//Play next element in the queue
						case 'skip':
						case 'next':
							{
								if (config.EnableSoundboard && checkPermission(guildMember, 7, message.channel)) {
									if (config.EnableSoundboard && soundIsPlaying && currVoiceConnection) {
										if (PlayingQueue.length > 0)
											playbackMessage(":track_next: Playing next! (requested by " + getUserTagName(message.author) + ").");
										stopPlayback(currVoiceConnection, false);
									}
								}
								break;
							}
						//Youtube audio
						case 'yt':
						case 'youtube':
							{
								if (config.EnableSoundboard && checkPermission(guildMember, 3, message.channel)) {
									if (checkForEmptyArguments(args, message.channel, message.author)) return;

									if (ytdl.validateURL(args[0])) {
										if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("YouTubeCommand", 'start') + " Recieved command!", 'c', config.logging.LogFileReport.DelayDebug); //debug message
										
										prepareForPlaybackOnChannel(guildMember)
											.then((connection) => {
												if (connection) {
													if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("YouTubeCommand") + " Checked channel presence.", 'c', config.logging.LogFileReport.DelayDebug); //debug message
													//Create Queue element
													QueueElement = { 'type': 'youtube', 'link': args[0], 'user': guildMember, 'flags': additionalFlags };
													//If something is playing right now
													if (soundIsPlaying) {
														if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("YouTubeCommand") + " Stopping playback.", 'c', config.logging.LogFileReport.DelayDebug); //debug message
														//Stop or pause the playback (depending on length of playing sound)
														stopPlayback(connection, true);
														//Add to the front position in queue
														PlayingQueue.unshift(QueueElement);
														//Do not run handleQueue() here, since it will be run due to dispatcher.end Event after stopping the playback
													}
													//Nothing is playing right now
													else {
														if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("YouTubeCommand", 'reset') + " Launching handleQueue().", 'c', config.logging.LogFileReport.DelayDebug); //debug message
														PlayingQueue.unshift(QueueElement);
														handleQueue('newSoundRequest');
													}
												}
											});
											
										
									}
									else
										sendInfoMessage("This is not a valid Youtube link!", message.channel, message.author);
								}
								break;
							}
						default:
							{
								if (config.EnableSoundboard) {
									if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("FileCommand", 'start') + " Recieved command!", 'c', config.logging.LogFileReport.DelayDebug); //debug message
									//Requested a local sound playback
									db.findSound(command)
										.then(found => {
											if (found.count == 1 || (!config.StrictAudioCommands && found.count > 1)) {
												if (checkPermission(guildMember, 2, message.channel)) {
													prepareForPlaybackOnChannel(guildMember)
														.then((connection) => {
															if (connection) {
																if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("FileCommand") + " Checked channel presence.", 'c', config.logging.LogFileReport.DelayDebug); //debug message
																
																//Create Queue element
																QueueElement = { 'type': 'file', 'filename': found.sound.filenameFull, 'user': guildMember, 'duration': found.sound.duration, 'flags': additionalFlags };
																
																//If something is playing right now
																if (soundIsPlaying) {
																	if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("FileCommand") + " Stopping playback!", 'c', config.logging.LogFileReport.DelayDebug); //debug message
																	//Stop or pause the playback (depending on length of playing sound)
																	stopPlayback(connection, true, found.sound.duration);
																	//Add to the front position in queue
																	PlayingQueue.unshift(QueueElement);
																	//Do not run handleQueue() here, since it will be run due to dispatcher.end Event after stopping the playback
																}
																//Nothing is playing right now
																else {
																	if (config.logging.ConsoleReport.DelayDebug) utils.report(utils.msCount("FileCommand", 'reset') + " Launching handleQueue().", 'c', config.logging.LogFileReport.DelayDebug); //debug message
																	PlayingQueue.unshift(QueueElement);
																	handleQueue('newSoundRequest');
																}
															}
														});
												}
											}
											else if (found.count > 1)
												sendInfoMessage("More than one result found!", message.channel, message.author);
											else
												sendInfoMessage("Unknown command! Type **" + config.CommandCharacter + "help**" + (config.RestrictCommandsToSingleChannel ? " in the <#" + config.ReportChannelId + "> channel or in DM" : "") + " to see instructions on how to use this bot.", message.channel, message.author);
										});
								}
								else
									sendInfoMessage("Unknown command! Type **" + config.CommandCharacter + "help**" + (config.RestrictCommandsToSingleChannel ? " in the <#" + config.ReportChannelId + "> channel or in DM" : "") + " to see instructions on how to use this bot.", message.channel, message.author);
							}
					}
				}
				else
					sendInfoMessage("I am reacting to commands on <#" + config.ReportChannelId + "> channel only!", message.channel, message.author);
				//Delete command sent by user
				if (config.DeleteUserCommands && message.channel.type != 'dm')
					message.delete()
						.catch(error => utils.report("Can't delete command message sent by " + userName + " on '" + message.channel.name + "' channel. Error: " + error, 'r'));
			}
			//If its a file sent in private
			if (message.channel.type == 'dm' && message.attachments.size > 0 && config.EnableSoundboard && config.AcceptDirectMessagesAudio) {
				if (checkPermission(guildMember, 4, message.channel)) {
					let attachments = message.attachments.array();
					for (i in attachments) {
						let attachment = attachments[i];
						utils.report(userName + " sent file '" + attachment.filename + "' of size " + Math.round(attachment.filesize / 1024) + " Kb.", 'm');
						if ((attachment.filesize / 1024 <= config.MessageAttachmentSizeLimitKb && config.MessageAttachmentSizeLimitKb > 0) || config.MessageAttachmentSizeLimitKb == 0) {
							//let targetFilename = attachment.filename.toLowerCase().replace(/[^a-z0-9_.]/g, '');
							let targetFilename = attachment.filename;
							let dest = path.resolve(__dirname, config.folders.Temp, targetFilename);
							let pathParse = path.parse(dest);
							let nameCleanNoExtension = pathParse.name.toLowerCase().replace(/[^a-z0-9_]/g, '');
							let nameClean = nameCleanNoExtension + pathParse.ext.toLowerCase();

							//let soundsDestination = path.resolve(__dirname, config.folders.Sounds, nameClean);
							if (!fs.existsSync(path.resolve(__dirname, config.folders.Sounds, nameClean))) {
								message.reply("Please, wait while I process the file...");
								let file = fs.createWriteStream(dest);
								let request = https.get(attachment.url, (response) => {
									response.pipe(file);
									file.on('finish', () => {
										file.close(() => {
											//Check if this file is a proper audio file
											utils.checkAudioFormat(dest)
												.then(result => {
													let destination = path.resolve(__dirname, config.folders.Sounds, nameClean);
													//If we found the proper format, no need to convert
													if (result['mode'] == "fits") {
														utils.moveFile(dest, path.resolve(__dirname, config.folders.Sounds, nameClean))
															.then(() => {
																message.reply("File added! Now you can play it using **" + config.CommandCharacter + nameCleanNoExtension + "** command.");
																db.userUploadedSoundsInc(message.author.id); //Increment value in DB for statistics
																utils.checkAudioFormat(path.resolve(__dirname, config.folders.Sounds, nameClean))
																	.then(resultNew => {
																		db.soundUpdateAdd(nameClean, resultNew['metadata']['format']['duration'], fs.statSync(path.resolve(__dirname, config.folders.Sounds, nameClean)).size, resultNew['metadata']['format']['bitrate'], message.author.id);
																	});
																//db.scanSoundsFolder();
															})
															.catch(err => {
																message.reply("There was an error while performing server operations! Operation was not finished.");
															});
													}
													//If format did fit, but we need to remux it because of several streams
													else if (result['mode'] == "remux") {
														utils.report("Recieved file '" + attachment.filename + "' from " + userName + ". Duration " + result['metadata']['format']['duration'] + " s, streams: " + result['metadata']['streams'].length + ". Need remuxing...", 'y');
														let outputFile = path.resolve(__dirname, config.folders.Temp, "remux_" + nameClean)
														ffmpeg(dest)
															.outputOptions(['-map 0:' + result['remuxStreamToKeep']])
															.noVideo()
															.audioCodec("copy")
															.on('error', function (err) {
																utils.report("ffmpeg reported error: " + err, 'r');
																utils.deleteFile(dest);
																utils.deleteFile(outputFile);
															})
															.on('end', function (stdout, stderr) {
																utils.deleteFile(dest);
																utils.moveFile(outputFile, path.resolve(__dirname, config.folders.Sounds, nameClean))
																	.then(() => {
																		message.reply("File added! Now you can play it using **" + config.CommandCharacter + nameCleanNoExtension + "** command.");
																		db.userUploadedSoundsInc(message.author.id); //Increment value in DB for statistics
																		utils.checkAudioFormat(path.resolve(__dirname, config.folders.Sounds, nameClean))
																			.then(resultNew => {
																				db.soundUpdateAdd(nameClean, resultNew['metadata']['format']['duration'], fs.statSync(path.resolve(__dirname, config.folders.Sounds, nameClean)).size, resultNew['metadata']['format']['bitrate'], message.author.id);
																			});
																		//db.scanSoundsFolder();
																	})
																	.catch(err => {
																		message.reply("There was an error while performing server operations! Operation was not finished.");
																	});
															})
															.output(outputFile)
															.run();
													}
													//If format didnt fit but its an audio, convert it
													else if (result['mode'] == "convert") {
														//result['audioStream'] = lastAudioStream;
														utils.report("Recieved file '" + attachment.filename + "' from " + userName + ". Duration " + result['metadata']['duration'] + " s, format: '" + result['metadata']['streams'][0]['codec_name'] + "', streams: " + result['metadata']['streams'].length + ". Converting...", 'y');
														let outputFile = path.resolve(__dirname, config.folders.Temp, nameCleanNoExtension + "." + config.ConvertUploadedAudioContainer)
														ffmpeg(dest)
															.outputOptions(['-map 0:' + result['audioStream']])
															.noVideo()
															.audioCodec(config.ConvertUploadedAudioCodec)
															.audioBitrate(config.ConvertUploadedAudioBitrate)
															.on('error', function (err) {
																utils.report("ffmpeg reported error: " + err, 'r');
																utils.deleteFile(dest);
																utils.deleteFile(outputFile);
															})
															.on('end', function (stdout, stderr) {
																utils.deleteFile(dest);
																utils.moveFile(outputFile, path.resolve(__dirname, config.folders.Sounds, nameCleanNoExtension + "." + config.ConvertUploadedAudioContainer))
																	.then(() => {
																		message.reply("File added! Now you can play it using **" + config.CommandCharacter + nameCleanNoExtension + "** command.");
																		db.userUploadedSoundsInc(message.author.id); //Increment value in DB for statistics
																		utils.checkAudioFormat(path.resolve(__dirname, config.folders.Sounds, nameCleanNoExtension + "." + config.ConvertUploadedAudioContainer))
																			.then(resultNew => {
																				db.soundUpdateAdd(nameCleanNoExtension + "." + config.ConvertUploadedAudioContainer, resultNew['metadata']['format']['duration'], fs.statSync(path.resolve(__dirname, config.folders.Sounds, nameCleanNoExtension + "." + config.ConvertUploadedAudioContainer)).size, resultNew['metadata']['format']['bitrate'], message.author.id);
																			});
																		//db.scanSoundsFolder();
																	})
																	.catch(err => {
																		message.reply("There was an error while performing server operations! Operation was not finished.");
																	});
															})
															.output(outputFile)
															.run();
													}
													//If we didnt find an audio, the file is not acceptable
													else {
														message.reply("Unknown file type. This is not an audio file.");
														utils.deleteFile(dest);
													}


												})
												.catch(err => {
													utils.report("Could't read file format. Error: " + err, 'r');
													message.reply("There was an error reading file's format. Looks like the file is corrupt.");
													fs.unlink(dest, err => {
														if (err)
															utils.report("Could't delete file '" + dest + "'. Error: " + err, 'r');
													});
												});
										});
									});
								}).on('error', function (err) { // Handle errors
									fs.unlink(dest); // Delete the file async. (But we don't check the result)
									utils.report("Couldn't download file! Error: " + err, 'r');
									message.reply("There was an error downloading the file that you sent. Please, try again.");
								});
							}
							else
								message.reply("File '" + nameClean + "' already exists, please rename the file and try again!");
						}
						else message.reply("This file is too big, it has to be less than " + config.MessageAttachmentSizeLimitKb + " Kb.");
					}
				}
			}
		
	}
	else if (message.channel.type == 'dm' || message.channel.type == 'group')
		utils.report("Direct message from user '" + message.author.username + "' (" + message.author.id + ") that is not part of the '" + client.guilds.get(config.guildId).name + "' guild: " + message.content, 'y');
});

process.on('uncaughtException', function (exception) {
	utils.report("uncaughtException: " + exception, 'r');
});

//Handle cleanup before program exits
process.stdin.resume();
function handleExitEvent() {
	utils.report("Recieved requested to stop the application, cleaning up...", 'y');
	let connection = getCurrentVoiceConnection();
	if (connection)
		stopPlayback(connection, false);
	writeQueueToDB()
	client.destroy();
	db.shutdown();
	setTimeout(() => {
		process.exit();
	}, 500);
};

process.on('SIGINT', handleExitEvent); //ctrl+c event
process.on('SIGUSR1', handleExitEvent); //kill pid
process.on('SIGUSR2', handleExitEvent); //kill pid


