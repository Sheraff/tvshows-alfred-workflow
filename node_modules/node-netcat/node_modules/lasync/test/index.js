var test = require('tape');

var lasync = require('../');

function a (cb) {
  console.log('run function "a"');
  setTimeout(function () {
    return cb(null);
  }, 2000);
}

function b (cb) {
  console.log('run function "b"');
  setTimeout(function () {
    return cb(null, 'Hello World');
  }, 1500);
}

function c (cb) {
  console.log('run function "c"');
  return cb(null, 123);
}

lasync.series([
  function (cb) {
    test('lasync - series', function (t) {
      t.plan(1);

      lasync.series([a, b, c], function (err, results) {
        if (err) t.fail(err);
        if (results) t.ok(results, '"' + results.join(', ') + '"');
        cb();
      });

    });
  }, 
  function (cb) {
    test('lasync - parallel', function (t) {
      t.plan(1);

      setTimeout(function () {
        lasync.parallel([a, b, c], function (err, results) {
          if (err) t.fail(err);
          if (results) t.ok(results, '"' + results.join(', ') + '"');
          cb();
        });
      }, 500);

    });
  },
  function (cb) {
    test('lasync - series with error', function (t) {
      t.plan(2);

      setTimeout(function () {
        lasync.series([
          function (callback) {
            return callback(null, 'ok');
          },
          function (callback) {
            // flow will end here
            return callback('this is a "series" error!!!!');
          },
          function (callback) {
            return callback(null, 'will not execute');
          }
        ], function (err, results) {
          if (err) t.ok(err, err);
          t.equal(results, undefined, 'will return "undefined"');
          cb();
        });
      }, 500);

    });
  },
  function (cb) {
    test('lasync - parallel with error', function (t) {
      t.plan(2);

      setTimeout(function () {
        lasync.parallel([
          function (callback) {
            // ERROR
            return callback('this is a "parallel" error!!!!');
          },
          function (callback) {
            // flow will end here
            return callback(null, 'ok');
          }
        ], function (err, results) {
          if (err) t.ok(err, err);
          t.equal(results, undefined, 'will return "undefined"');
          cb();
        });
      }, 500);

    });
  },
  function (cb) {
    test('lasync - waterfall', function (t) {
      t.plan(5);

      setTimeout(function () {
        lasync.waterfall([
          function (cb) {
            t.pass('first waterfall');
            cb(null, 'Hello', 'World');
          },
          function (arg1, arg2, cb) {
            setTimeout(function () {
              t.ok(arg1 && arg2, 'second waterfall ' + arg1 + ' ' +  arg2);
              cb(null, arg1 + ' - ' + arg2);
            }, 1000);
          },
          function (arg1, cb) {
            t.ok(arg1, 'third waterfall ' + arg1);
            cb(null, arg1.replace(' -', '') + '!!!!');
          },
          function (arg1, cb) {
            setTimeout(function () {
              t.ok(arg1, 'fourth waterfall ' + arg1);
              cb(null, 'ok');
            }, 1000);
          }
        ], function (err, result) {
          if (err) t.fail('waterfall error ' + err);
          t.ok(result, 'waterfall return: ' + result);
          cb();
        });
      }, 500);
    });
  },
  function (cb) {
    test('lasync - waterfall with error', function (t) {
      t.plan(3);

      setTimeout(function () {
        lasync.waterfall([
          function (cb) {
            t.pass('first waterfall');
            cb(null, 'Hello', 'World');
          },
          function (arg1, arg2, cb) {
            setTimeout(function () {
              t.ok(arg1 && arg2, 'second waterfall and will return error - ' + arg1 + ' ' +  arg2);
              cb('waterfalllllllll');
            }, 1000);
          },
          function (arg1, cb) {
            // this will not run
            t.ok(arg1, 'third waterfall ' + arg1);
            cb(null, arg1.replace(' -', '') + '!!!!');
          }
        ], function (err, result) {
          if (err) t.ok(err, 'waterfall error: ' + err);
          cb();
        });
      }, 500);
    });
  }]
);