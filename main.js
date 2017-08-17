var fs = require('fs');
var http = require('http');
var net = require('net');
var crypto = require('crypto');
var request = require('request');
var xml2js = require('xml2js');              // 将xml解析为js对象
var iconv = require('iconv-lite');           // 解决汉字乱码问题
var express = require('express');            // express
var bodyParser = require('body-parser');     // 配合express使用
var mysql = require('mysql');
var config = require('./config');            // 从config.json读取配置信息

// configuration arguments --------------------------------------------------------------------
var httpServerPort = 4000;                    // 为外部系统提供的访问端口
if (config.httpServerPort != undefined)
    httpServerPort = config.httpServerPort;

var vmsServerIP = '192.168.103.101';         // CNMU的ip地址
if (config.vmsServerIP != undefined)
    vmsServerIP = config.vmsServerIP;

var vmsServerPort = 10003;                    // CMU的访问端口
if (config.vmsServerPort != undefined)
    vmsServerPort = config.vmsServerPort;

var retryTimeout = 30000;                     // 本单元向CMU注册失败后重新尝试注册的时间间隔
if (config.retryTimeout != undefined)
    retryTimeout = config.retryTimeout;

var serverId = '2102002005000006';           // 在CMU中为本单元分配的id，本单元复用原有的MGU类型
if (config.serverId != undefined)
    serverId = config.serverId;

var serverIp = '192.168.65.3';               // 本单元所在的ip地址
if (config.serverIp != undefined)
    serverIp = config.serverIp;

var serverLoginName = 'admin';                // 本单元登录CMU时使用的用户名
if (config.serverLoginName != undefined)
    serverLoginName = config.serverLoginName;

var serverPassword = '123456';                // 本单元登录CMU时使用的口令
if (config.serverPassword != undefined)
    serverPassword = config.serverPassword;

var dbHost = '192.168.103.101';              // CMU数据库地址
if (config.dbHost != undefined)
    dbHost = config.dbHost;

var dbUser = 'root';                          // 数据库用户
if (config.dbUser != undefined)
    dbUser = config.dbUser;

var dbPassword = '123456';                    // 数据库用户口令
if (config.dbPassword != undefined)
    dbPassword = config.dbPassword;

var outerHttpServerIP = 'http://127.0.0.1';          // 外部系统IP,本结点发送告警等信息的目的地
if (config.outerHttpServerIP != undefined)
    outerHttpServerIP = config.outerHttpServerIP;

var outerHttpServerPort = 4000;                  // 外部系统port,本结点发送告警等信息的目的地
if (config.outerHttpServerPort != undefined)
    outerHttpServerPort = config.outerHttpServerPort;

// global arguments --------------------------------------------------------------------
var connectionToVMS;                          // 与CMU的Tcp长连接对象
var vmsServerConnectionStatus = false;        // 本单元与CMU之间TCP长连接的链接状态
var orderSequence = 0;                        // 用于生成向CMU发送的数据报序列号，每次加1
var vmsReadingBuffer = new Buffer('');       // 从CMU读取信息的buffer，用于处理粘包和分包

var registerTimeoutHandler = null;           // 记录本单元向CMU注册时创建的超时句柄

var app;                                      //  Web应用对象
var waitingRequestsList= {};                  // 记录正在等待处理结果的外部系统http请求

function createVmsSendingBuffer(packageStr) {
    var diagramArr = [0x02,0x00];

    var len = packageStr.length;
    diagramArr[5] = len % 256;
    len = parseInt(len/256);
    diagramArr[4] = len % 256;
    len = parseInt(len/256);
    diagramArr[3] = len % 256;
    len = parseInt(len/256);
    diagramArr[2] = len % 256;

    orderSequence = orderSequence + 1;
    len = orderSequence;
    diagramArr[9] = len % 256;
    len = parseInt(len/256);
    diagramArr[8] = len % 256;
    len = parseInt(len/256);
    diagramArr[7] = len % 256;
    len = parseInt(len/256);
    diagramArr[6] = len % 256;

    var diagramBuf = new Buffer(diagramArr);
    var packageStrBuf = new Buffer(packageStr);

    return Buffer.concat([diagramBuf,packageStrBuf],diagramArr.length + packageStrBuf.length);
}

function getRequestFromList(seq) {
    var oo = waitingRequestsList[seq];

    if (oo == undefined)
        return null;

    delete waitingRequestsList[seq];
    return oo;
}

function writeResponseInDetail(res,statusCode,contentType,message) {
    res.writeHead(statusCode,contentType);
    res.write(message);
    res.end();
}

function pushWaitingRequestList(req,res) {
    var obj = {
        request : req,
        response : res,
        timestamp : new Date(),
    };

    waitingRequestsList[orderSequence] = obj;
}

function getRegisterRequestBuffer() {
    var reqStr = '<?xml version="1.0" encoding="GB2312" standalone="yes"?>\r\n';
    reqStr = reqStr + '<request command="MguRegister">\r\n';
    reqStr = reqStr + '  <parameters>\r\n';
    reqStr = reqStr + '    <serverId>' + serverId + '</serverId>\r\n';
    reqStr = reqStr + '    <serverIp>' + serverIp + '</serverIp>\r\n';
    reqStr = reqStr + '    <serverLoginName>' + serverLoginName + '</serverLoginName>\r\n';
    reqStr = reqStr + '    <serverPassword>' + crypto.createHash('md5').update(serverPassword).digest('hex') + '</serverPassword>\r\n';
    reqStr = reqStr + '    <serverVersion>1</serverVersion>\r\n';
    reqStr = reqStr + '    <serverPort>6</serverPort>\r\n';
    reqStr = reqStr + '    <httpPort>8080</httpPort>\r\n';
    reqStr = reqStr + '  </parameters>\r\n';
    reqStr = reqStr + '</request>';

    return createVmsSendingBuffer(reqStr);
}

function sendGetCamerasRequestToVMS(req,res) {
    var reqStr = '<?xml version="1.0" encoding="GB2312" standalone="yes"?>\r\n';
    reqStr = reqStr + '<request command="GetAllDeviceList">\r\n';
    reqStr = reqStr + '  <parameters>\r\n';
    reqStr = reqStr + '    <cuId>6</cuId>\r\n';
    reqStr = reqStr + '    <cuUserName>2102003003000001</cuUserName>\r\n';
    reqStr = reqStr + '  </parameters>\r\n';
    reqStr = reqStr + '</request>';

    connectionToVMS.write(createVmsSendingBuffer(reqStr));
    pushWaitingRequestList(req,res);
}

function selectFromDb(req,res,sql) {
    pool.getConnection(function(err,connection){
        if (err) {
            console.log('ERROR : ',err);
            writeResponseInDetail(res,500,{'Content-Type':'text/plain;charset=utf-8'},'Get connection from pool error!');
            connection.release();
            return;
        }

        connection.query(sql,function (error, results, fields){
            if (error) {
                console.log('ERROR : ',error);
                writeResponseInDetail(res,500,{'Content-Type':'text/plain;charset=utf-8'},'select from camera error!');
                connection.end();
                return;
            }

            writeResponseInDetail(res,200,{'Content-Type':'application/json;charset=utf-8'},JSON.stringify(results));
            connection.release();
        });

    });
}

/*
 * create connection to VMS server
 */
(function connectToVMS() {

    function retryConnect() {
        registerTimeoutHandler = null;
        setTimeout(connectToVMS,retryTimeout);
    }

    function registerTimeout() {
        console.log('INFO : can not get register response in time!');

        connectionToVMS.end();
        vmsServerConnectionStatus = false;
        retryConnect();
    }

    console.log('INFO : connecting to VMS Server ......');

    connectionToVMS = net.createConnection(vmsServerPort, vmsServerIP);

    connectionToVMS.on('connect', function () {
        console.log('INFO : connected to VMS server and send register request!');

        var buf = getRegisterRequestBuffer();
        connectionToVMS.write(buf);

        registerTimeoutHandler = setTimeout(registerTimeout,10000);
    });

    connectionToVMS.on('data', function (data) {
        var version;
        var bodyLength;
        var packageSeq;
        var bodyStr;

        vmsReadingBuffer = Buffer.concat([vmsReadingBuffer,data],vmsReadingBuffer.length + data.length);

        while (true) {
            if (vmsReadingBuffer.length < 2) {
                if (vmsReadingBuffer.length > 0) {
                    console.log('INFO : data length < 2, wait for more data');
                }
                return;
            }

            if (vmsReadingBuffer[0] == 0x02 && vmsReadingBuffer[1] == 0x00) {
                console.log('INFO : Protocol version:2.0');

                if (vmsReadingBuffer.length < 10) {
                    console.log('INFO : receiving data length < 10 when protocol version is 2.0, wait for more data');
                    return;
                }

                version = '2.0';
                bodyLength = vmsReadingBuffer[2] * 256 * 256 * 256 + vmsReadingBuffer[3] * 256 * 256 + vmsReadingBuffer[4] * 256 + vmsReadingBuffer[5];
                packageSeq = vmsReadingBuffer[6] * 256 * 256 * 256 + vmsReadingBuffer[7] * 256 * 256 + vmsReadingBuffer[8] * 256 + vmsReadingBuffer[9];

                if (vmsReadingBuffer.length < 10 + bodyLength) {
                    console.log('INFO : receiving data length < 10+bodyLength when version is 2.0, wait for more data');
                    return;
                }

                bodyStr = iconv.decode(vmsReadingBuffer.slice(10,10 + bodyLength), 'GBK').toString();
                vmsReadingBuffer = vmsReadingBuffer.slice(10+bodyLength);

            } else if (vmsReadingBuffer[0] == 0x01 && vmsReadingBuffer[1] == 0x00) {
                console.log('INFO :Protocol version:1.0');

                if (vmsReadingBuffer.length < 8) {
                    console.log('INFO : receiving data length < 8 when protocol version is 1.0, wait for more data');
                    return;
                }

                version = '1.0';
                bodyLength = vmsReadingBuffer[2] * 256 + vmsReadingBuffer[3];
                packageSeq = vmsReadingBuffer[4] * 256 * 256 * 256 + vmsReadingBuffer[5] * 256 * 256 + vmsReadingBuffer[6] * 256 + vmsReadingBuffer[7];

                if (vmsReadingBuffer.length < 8 + bodyLength) {
                    console.log('INFO : data length != 8+bodyLength when version is 1.0, wait for more data');
                    return;
                }

                bodyStr = iconv.decode(data.slice(8,8 + bodyLength), 'GBK').toString();
                vmsReadingBuffer = vmsReadingBuffer.slice(8+bodyLength);

            } else {
                console.log('ERROR : invalid protocol version');
                vmsReadingBuffer = vmsReadingBuffer.slice(1);
                continue;
            }

            console.log('----------------->Get new package<-----------------');
            console.log('Version=', version);
            console.log('Body Length=', bodyLength);
            console.log('Package Sequence=', packageSeq);
            console.log('Body String=', bodyStr);

            (function (bs,ps) {
                xml2js.parseString(bs, {explicitArray: false}, function (err, result) {
                    if (err) {
                        console.log('Parse XML to JSON error:', err);
                        return;
                    }

                    try {
                        if (result.response !== undefined) {
                            switch (result.response.$.command) {
                                case 'MguRegister':
                                    if (registerTimeoutHandler != null) {
                                        clearTimeout(registerTimeoutHandler);
                                        registerTimeoutHandler = null;
                                    }

                                    vmsServerConnectionStatus = true;

                                    console.log('VMS server is connected!');
                                    break;

                                case 'GetAllDeviceList':
                                    var obj = getRequestFromList(ps);

                                    if (obj == null) {
                                        console.log('error : There is not waiting for this package!');
                                    } else {
                                        writeResponseInDetail(obj.response, 200, {'Content-Type': 'text/xml;charset=utf-8'}, bodyStr);
                                    }

                                    break;
                                default:
                                    console.log('ERROR : invalid response command : ', result.response.$.command);
                            }
                        } else if (result.request !== undefined) {
                            //console.log('INFO : This is a response package:',result);
                            switch (result.request.$.command) {
                                case 'RaiseAlarm':
                                    var sendObj = {
                                        alarmId : result.request.parameters.alarmCode,
                                        cameraId : result.request.parameters.alarmSourceId.substr(0,16),
                                        alarmType : result.request.parameters.alarmSourceId.substr(16),
                                        timeStamp : result.request.parameters.timeStamp,
                                        eliminated : result.request.parameters.eliminated
                                    };
                                    console.log('INFO : send object : ', sendObj);

                                    var options = {
                                        headers: {'Connection': 'close'},
                                        url: outerHttpServerIP+':'+outerHttpServerPort+'/alarms',
                                        method: 'POST',
                                        json:true,
                                        body:sendObj
                                    };

                                    function callback(error, response, data) {
                                        if (error) {
                                            console.log('ERROR : ',error);
                                            return;
                                        }

                                        if (response.statusCode == 200) {
                                            console.log('INFO : ',data);
                                        } else {
                                            console.log('ERROR : ',data);
                                        }
                                    }

                                    request(options, callback);

                                    break;
                                default:
                                    console.log('ERROR : invalid request command : ', result.request.$.command);
                            }
                        } else {
                            console.log('ERROR : The package is neither request nor reponse!');
                        }
                    } catch (e) {
                        console.log('!!!!!!!!!!!!!!Exception when dealing with the package from VMS:');
                        console.log(e);
                    }

                });
            }(bodyStr,packageSeq));

        }
    });

    connectionToVMS.on('close', function () {
        vmsServerConnectionStatus = false;
        retryConnect();
    });

    connectionToVMS.on('end', function () {
        console.log('disconnected from VMS server');
    });

    connectionToVMS.on('error', function (err) {
        console.log('connect to VMS server error :', err);
        vmsServerConnectionStatus = false;
        retryConnect();
    });

}());

/*
 * create http server
 */
var pool = mysql.createPool({
    host : dbHost,
    user : dbUser,
    password : dbPassword,
    database: 'vms'
});

var app = express();
app.use(bodyParser.json());  // 需要request中的Content-Type: application/json,不然解析不出来

app.use(function(req,res,next){
    console.log('>>>>>>>>>>>>>>>>>>>>>>Get new http request<<<<<<<<<<<<<<<<<<<<<<');
    console.log('req.method=',req.method);
    console.log('req.url=',req.url);
    console.log('req.body=',req.body);
    console.log('req.params=',req.params);
    console.log('req.query=',req.query);
    next();
});

app.post('/vms/records',function (req,res) {
    writeResponseInDetail(res,500,{'Content-Type':'text/plain;charset=utf-8'},'Waiting for implementation!');
});

app.get('/vms/images/:cameraid/:presetid',function (req,res) {
    console.log('req.params.cameraid=',req.params.cameraid);
    console.log('req.params.presetid=',req.params.presetid);
    writeResponseInDetail(res,500,{'Content-Type':'text/plain;charset=utf-8'},'Waiting for implementation!');
});

app.get('/vms/cameras',function (req,res) {
    selectFromDb(req,res,'select camera_device_id as cameraId,name as name,description as description,install_location as install_location,cameraType as cameraType,ptzEnable as ptzEnable from camera');
});

app.get('/vms/statuses',function (req,res) {
    selectFromDb(req,res,'select camera_device_id as cameraId,is_online as status from camera');
});

//--------------------------------------------------------------------------------------------
// 以下是作为测试用
app.get('/vms/test',function (req,res) {
    sendGetCamerasRequestToVMS(req,res);
});

app.post('/alarms',function (req,res) {
    writeResponseInDetail(res,200,{'Content-Type':'text/plain;charset=utf-8'},'Got Alarms!');
});

app.listen(httpServerPort);