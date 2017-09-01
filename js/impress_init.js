$(document).ready(function(){
  impress().init();
  var slides = [];
  $("#pages").children("h1").each(function(index){
    var onepage = $(this).nextUntil("h1");
    var div = $("#impress").add("div");
    div.addClass("step");
    div.add(this);
    div.add(onepage);
  });
});