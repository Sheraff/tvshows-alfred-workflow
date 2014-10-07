# lasync

An simple and tiny async library for control flow.

<a href="https://nodei.co/npm/lasync/"><img src="https://nodei.co/npm/lasync.png?downloads=true"></a>

[![Build Status](https://travis-ci.org/joaquimserafim/lasync.png?branch=master)](https://travis-ci.org/joaquimserafim/lasync)

[![browser support](https://ci.testling.com/joaquimserafim/lasync.png)](https://ci.testling.com/joaquimserafim/lasync)

**V1.1**

####series

Runs an array of functions in series, each passing their results to the next in the array, but, if any of the functions pass an error to the callback, the next function is not executed and the main callback is immediately called with the error.


	lasync.series("array tasks", [callback(err, results)])
    
    // results is an array
      
    // CODE
    
    var lasync = require('lasync');
    
    function a (cb) {
        console.log('run function "a"');
        setTimeout(function () {
          return cb(null);
        }, 3000);
    }
    
    function b (cb) {
        console.log('run function "b"');
        setTimeout(function () {
          return cb(null, 'Hello World');
        }, 2500);
    }
    
    function c (cb) {
        console.log('run function "c"');
        return cb(null, 1);
    }
    
    lasync.series([a, b, c], function (err, results) {
      if (err) throw err;
      console.log(results);
    });
      

####parallel

Run an array of functions in parallel, without waiting until the previous function has completed, but, if any of the functions pass an error to the callback, the main callback is immediately called with the value of the error.

	lasync.parallel("array tasks", [callback(err, results)])		
    
    // results is an array
    
    
    // CODE
    
    var lasync = require('lasync');
    
    
    // the same functions for example
    function a (cb) {
        console.log('run function "a"');
        setTimeout(function () {
          return cb(null);
        }, 3000);
    }
    
    function b (cb) {
        console.log('run function "b"');
        setTimeout(function () {
          return cb(null, 'Hello World');
        }, 2500);
    }
    
    function c (cb) {
        console.log('run function "c"');
        return cb(null, 1);
    }
    
    lasync.parallel([a, b, c]);
    
    
####waterfall

Runs an array of functions in series, each passing their results to the next in the array, but, if any of the functions pass an error to the callback, the next function is not executed and the main callback is immediately called with the error.



    waterfall("array tasks", [callback(err, result)])
    
    // results is an array
      
    // CODE
    
    var lasync = require('lasync');
    
    function a (cb) {
        console.log('run function "a"');
        setTimeout(function () {
          return cb(null, 'Hello');
        }, 3000);
    }
    
    function b (arg, cb) {
        console.log('run function "b"');
        setTimeout(function () {
          return cb(null, arg, 'World');
        }, 2500);
    }
    
    function c (arg1, arg2, cb) {
        console.log('run function "c"');
        return cb(null, arg1 + ' ' + arg2);
    }
    
    waterfall([a, b, c], function (err, result) {
      if (err) throw err;
      console.log(result);
    });
